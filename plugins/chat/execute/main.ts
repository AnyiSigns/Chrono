// `chat` 服务进程入口：宿主服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道：装配与计划合并下沉到本服务，
// 回合管道经反向调用 `port.call loop-policy.interpret`（title 旁路段 `session-title.generate`）。
// 接线（切片 / title 段 / 空槽）启动时读同包 `schema/wiring.json`。

import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers } from './methods.ts'
import { PortLink } from './port-link.ts'
import { DefUnavailableError } from './refs.ts'
import { IDENTITY, IMPLEMENTS, METHODS, PROTOCOL, READONLY_METHODS, STATE } from './plugin.ts'
import { isRecord } from './plan.ts'
import { loadWiring } from './wiring.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

const LINK = new PortLink((message) => writeFrame(message))
const HANDLERS = createHandlers({ port: LINK, host: LINK, wiring: loadWiring() })

const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[IDENTITY])
    ? (METHODS[IDENTITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : Object.keys(HANDLERS),
)

let exiting = false

function manifest(): Rec {
  return {
    v: '1',
    identity: IDENTITY,
    implements: IMPLEMENTS,
    methods: METHODS,
    protocol: PROTOCOL,
    state: STATE,
  }
}

function sendFrame(message: Json): void {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${(err as Error).message}`)
  }
}

function sendError(id: string, code: string, message: string): void {
  sendFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

/** 帧 env：宿主填写、机械；缺失回落 `{run:null, thread:null, now:0}`（服务绝不自取时钟）。 */
function parseEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

async function handleCall(message: Rec): Promise<void> {
  const id = typeof message['id'] === 'string' ? (message['id'] as string) : ''
  const port = message['port']
  const method = message['method']
  if (typeof port !== 'string' || typeof method !== 'string') {
    sendError(id, 'bad_args', 'port and method must be strings')
    return
  }
  if (!IMPLEMENTS.includes(port)) {
    sendError(id, 'unresolved_cap', `unknown capability ${port}`)
    return
  }
  if (!DECLARED_METHODS.has(method)) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const handler = HANDLERS[method]
  if (handler === undefined) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const args = message['args']
  if (args !== undefined && args !== null && !isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  try {
    const value = await handler(args ?? null, parseEnv(message['env']))
    sendFrame({ v: '1', id, kind: 'result', ok: true, value })
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    if (err instanceof DefUnavailableError) {
      sendError(id, 'def_unavailable', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
  }
}

/** 停机：未结算的反向调用作数据失败，然后退出（先让协议帧写完）。 */
function shutdown(): void {
  if (exiting) return
  exiting = true
  LINK.failAll()
  setTimeout(() => process.exit(0), 10).unref?.()
}

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
  switch (message['kind']) {
    case 'hello':
      sendFrame({ id: message['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: '1', id: message['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
      sendFrame({ v: '1', id: message['id'], kind: 'ack' })
      return
    case 'drain':
      sendFrame({ v: '1', id: message['id'], kind: 'bye' })
      shutdown()
      return
    case 'call':
      await handleCall(message)
      return
    default:
      return
  }
}

/**
 * 只读 call 判定：kind=call 且 method 由声明派生为只读。只读方法不推进状态，
 * 可在串行链之外并发；其余帧仍走链保证到达序（send / resume 必须在链上）。
 */
function isReadonlyCall(message: Json): boolean {
  if (!isRecord(message) || message['kind'] !== 'call') return false
  const method = message['method']
  return typeof method === 'string' && READONLY_METHODS.has(method)
}

const decoder = createFrameDecoder()
// 串行链：保证同一连接上的消息按到达序处理；反向调用应答立即结算（不排队），
// 否则正在 await port.result 的 call 会把链堵死。
// 只读 call 不排队：长回合（send 整段 await interpret）会占住链，读命令若排队
// 必被宿主侧方法超时先掐断。
let chain: Promise<void> = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  let messages: Json[]
  try {
    messages = decoder.push(chunk)
  } catch (err) {
    log(`bad frame: ${(err as Error).message}`)
    return
  }
  for (const message of messages) {
    if (isRecord(message) && LINK.settle(message)) continue
    if (isReadonlyCall(message)) {
      void handle(message).catch((err: unknown) => log(`readonly handle error: ${(err as Error).message}`))
      continue
    }
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

log(`service started (pid ${process.pid})`)
