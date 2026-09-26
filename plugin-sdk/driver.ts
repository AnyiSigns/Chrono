// 服务测试驱动：spawn stdio 服务、按 id 配对请求、自动应答反向 `port.call`。
// 供 SDK 与插件测试复用，消除每插件一份帧编解码 + spawn + 配对 + port bridge。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { createFrameDecoder, encodeFrame, SERVICE_PROTOCOL_VERSION } from './wire.ts'
import type { Json, Rec } from './json.ts'

/** 反向调用应答：`ok` 为真带值，为假带错误码与描述。 */
export interface PortBridgeResponse {
  ok: boolean
  value?: Json
  code?: string
  message?: string
}

export interface ServiceDriverOptions {
  /** 服务入口模块路径。 */
  entry: string
  /** 工作目录（插件包根）。 */
  cwd: string
  /** 追加到 `process.env` 的环境变量（如 ③ / ④ 目录）。 */
  env?: Record<string, string | undefined>
  /** 反向调用应答；缺省 `{ok:true, value:null}`。 */
  onPortCall?: (message: Rec) => PortBridgeResponse
  /** 单请求等待上限；缺省 5000ms。 */
  timeoutMs?: number
}

export interface ServiceDriver {
  readonly child: ChildProcess
  /** 服务主动上行的事件帧（按到达序）。 */
  readonly events: Rec[]
  /** 服务发出的反向调用帧（按到达序）。 */
  readonly portCalls: Rec[]
  /** 服务退出码。 */
  readonly exit: Promise<number | null>
  /** 发任意协议帧并按 id 等期望种类。 */
  request(
    kind: string,
    fields: Record<string, Json>,
    expect: string | readonly string[],
  ): Promise<Rec>
  /** 能力调用；返回 result / error 帧。 */
  call(port: string, method: string, args: Json, env?: Json): Promise<Rec>
  /** 握手；返回 manifest 帧。 */
  hello(impl: string, gen?: string): Promise<Rec>
  /** 关 stdin，触发服务自退出。 */
  close(): void
}

/** spawn 一个 stdio 服务并接线测试驱动。 */
export function startService(options: ServiceDriverOptions): ServiceDriver {
  const env = { ...process.env, ...(options.env ?? {}) }
  const child = spawn(process.execPath, [options.entry], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const decoder = createFrameDecoder()
  const pending = new Map<string, (message: Rec) => void>()
  const events: Rec[] = []
  const portCalls: Rec[] = []
  const timeoutMs = options.timeoutMs ?? 5000
  const exit = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code))
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      if (!isRecordMessage(message)) continue
      if (message['kind'] === 'event') {
        events.push(message)
        continue
      }
      if (message['kind'] === 'port.call') {
        portCalls.push(message)
        const response = options.onPortCall?.(message) ?? { ok: true, value: null }
        child.stdin?.write(encodeFrame(portResponse(message['id'], response)))
        continue
      }
      const handler = typeof message['id'] === 'string' ? pending.get(message['id']) : undefined
      if (handler !== undefined) {
        pending.delete(message['id'] as string)
        handler(message)
      }
    }
  })
  child.stderr?.on('data', () => {})

  let seq = 0
  function request(
    kind: string,
    fields: Record<string, Json>,
    expect: string | readonly string[],
  ): Promise<Rec> {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise<Rec>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message['kind'] as string)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${String(message['kind'])}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin?.write(encodeFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields }))
    })
  }

  return {
    child,
    events,
    portCalls,
    exit,
    request,
    call(port: string, method: string, args: Json, env?: Json): Promise<Rec> {
      const fields: Record<string, Json> = { port, method, args }
      if (env !== undefined) fields['env'] = env
      return request('call', fields, ['result', 'error'])
    },
    hello(impl: string, gen = 'gen-1'): Promise<Rec> {
      return request('hello', { impl, gen }, 'manifest')
    },
    close(): void {
      child.stdin?.end()
    },
  }
}

function isRecordMessage(value: Json): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portResponse(id: Json, response: PortBridgeResponse): Json {
  if (response.ok) {
    return {
      v: SERVICE_PROTOCOL_VERSION,
      id: typeof id === 'string' ? id : '',
      kind: 'port.result',
      ok: true,
      value: response.value ?? null,
    }
  }
  return {
    v: SERVICE_PROTOCOL_VERSION,
    id: typeof id === 'string' ? id : '',
    kind: 'port.error',
    ok: false,
    error: response.code ?? 'port_failed',
    message: response.message ?? '',
  }
}
