// 服务派发器与三形态入口：stdio 下起帧循环，inproc / worker 下由宿主 import 后直调。
// 同一份派发逻辑，故三种 transport 对同一组调用产出逐字节一致的结果与事件。
// manifest 从同包 plugin.json 派生；能力 / 方法 / args 形态门禁与错误映射集中在此。

import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCallEnv } from './env.ts'
import { isRecord } from './json.ts'
import { declaredMethods, deriveManifest, readPluginJson } from './manifest.ts'
import { createFrameDecoder, writeFrame, SERVICE_PROTOCOL_VERSION } from './wire.ts'
import { BadArgsError, ServiceError } from './types.ts'
import type { Json, Rec } from './json.ts'
import type { ServiceManifest } from './manifest.ts'
import type { Handler, ServiceEvent } from './types.ts'

/** 宿主 loader 传给同语言入口的上下文（与 assembly/service-host.ts 的 ServiceFactoryContext 同形）。 */
export interface ServiceFactoryContext {
  /** 服务 → 宿主发一帧。 */
  emit: (message: Json) => void
  /** ③ / ④ 目录（只含已注入项）。 */
  env: Record<string, string>
}

export interface ServiceConfig {
  /** 插件包根目录（含 `plugin.json`）。 */
  pluginRoot: string
  /** 本服务的能力类名（缺声明时的回落）。 */
  capability: string
  /** 方法表：方法名 → 处理器。 */
  handlers: Record<string, Handler>
  /** 发帧出口。 */
  emit: (message: Json) => void
  /** 缺省状态档；`plugin.json` 缺 `state` 时用。 */
  defaultState?: string
  /** 日志出口（stderr）；缺省以 identity 为前缀。 */
  log?: (line: string) => void
  /** 帧进入派发前的拦截（反向应答结算等）；返回 true 表示已消费。 */
  intercept?: (message: Rec) => boolean
  /** `drain` 帧后的清理钩子（结算在途反向调用等）。 */
  onDrain?: () => void
  /** 通道关闭 / stdin EOF 时的清理钩子。 */
  onClose?: () => void
  /** `drain` 后延迟自退出的毫秒数；缺省不自退出（由 stdin EOF 收口）。 */
  drainExitMs?: number
  /** 事件帧 id 前缀；缺省 `<identity>-evt`。 */
  eventIdPrefix?: string
}

/** 一个已装载的服务实例：收协议帧、可关闭。 */
export interface ServiceInstance {
  receive(message: Json): void
  close(): void
}

/** 日志出口工厂：统一 `[<prefix>] ` 前缀，日志只走 stderr。 */
export function makeLogger(prefix: string): (line: string) => void {
  return (line: string): void => {
    process.stderr.write(`[${prefix}] ${line}\n`)
  }
}

/** 由入口模块 URL 取插件包根目录（入口位于 `<pkg>/execute/` 下）。 */
export function packageRootOf(importMetaUrl: string): string {
  return dirname(dirname(fileURLToPath(importMetaUrl)))
}

/** 从 `process.env` 取已注入的 ③ / ④ 目录（stdio 形态的 loader 参数）。 */
export function loaderEnvFromProcess(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['CHRONO_PLUGIN_STATE', 'CHRONO_PLUGIN_DATA']) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/** 本模块是否被直接运行（stdio 形态）；被 import 时（inproc / worker）为 false。 */
export function isDirectRun(importMetaUrl: string): boolean {
  const argv1 = process.argv[1]
  return argv1 !== undefined && importMetaUrl === pathToFileURL(argv1).href
}

/**
 * 构造一个与 transport 无关的服务实例。
 * stdio 由 `runStdio` 喂入 stdin 帧；inproc / worker 由宿主把帧交给 `receive`。
 */
export function createService(config: ServiceConfig): ServiceInstance {
  const plugin = readPluginJson(config.pluginRoot)
  const manifest = deriveManifest(plugin, config.capability, config.defaultState ?? 'recomputable')
  const declared = declaredMethods(manifest, config.capability, config.handlers)
  const emit = config.emit
  const log = config.log ?? makeLogger(manifest.identity)
  const eventIdPrefix = config.eventIdPrefix ?? `${manifest.identity}-evt`
  let eventSeq = 0
  let chain: Promise<void> = Promise.resolve()

  function sendError(id: string, code: string, message: string): void {
    emit({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'error', ok: false, code, message })
  }

  function sendEvents(events: ServiceEvent[]): void {
    for (const event of events) {
      eventSeq += 1
      emit({
        v: SERVICE_PROTOCOL_VERSION,
        id: `${eventIdPrefix}-${eventSeq}`,
        kind: 'event',
        topic: event.topic,
        payload: event.payload,
      })
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
    if (!manifest.implements.includes(port)) {
      sendError(id, 'unresolved_cap', `unknown capability ${port}`)
      return
    }
    if (!declared.has(method)) {
      sendError(id, 'unknown_method', `unknown method ${method}`)
      return
    }
    const handler = config.handlers[method]
    if (handler === undefined) {
      sendError(id, 'unknown_method', `unknown method ${method}`)
      return
    }
    const rawArgs = message['args']
    if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
      sendError(id, 'bad_args', 'args must be an object')
      return
    }
    const env = parseCallEnv(message['env'])
    try {
      const result = await handler(rawArgs ?? null, env)
      sendEvents(result.events)
      emit({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'result', ok: true, value: result.value })
    } catch (err) {
      if (err instanceof BadArgsError) {
        sendError(id, 'bad_args', err.message)
        return
      }
      if (err instanceof ServiceError) {
        sendError(id, err.code, err.message)
        return
      }
      log(`method ${method} failed`)
      sendError(id, 'internal', 'handler failed')
    }
  }

  function handleOne(message: Rec): void | Promise<void> {
    switch (message['kind']) {
      case 'hello':
        emit({ id: message['id'], kind: 'manifest', ...manifest })
        return
      case 'probe':
        emit({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'pong', ok: true })
        return
      case 'reload':
        log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
        emit({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'ack' })
        return
      case 'drain':
        emit({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'bye' })
        config.onDrain?.()
        if (config.drainExitMs !== undefined) {
          setTimeout(() => process.exit(0), config.drainExitMs).unref?.()
        }
        return
      case 'call':
        return handleCall(message)
      default:
        return
    }
  }

  function handle(message: Json): void {
    if (!isRecord(message)) return
    if (config.intercept?.(message) === true) return
    chain = chain
      .then(() => handleOne(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }

  return {
    receive(message: Json): void {
      handle(message)
    },
    close(): void {
      config.onClose?.()
    },
  }
}

/**
 * stdio 形态入口：起 stdin 帧循环、stdout 只发协议帧，stdin EOF / 管道断开即自退出。
 * @param build 用 stdio 出口与进程 env 构造服务实例的工厂
 * @param options 日志出口
 */
export function runStdio(
  build: (ctx: ServiceFactoryContext) => ServiceInstance,
  options: { log?: (line: string) => void } = {},
): void {
  const log = options.log ?? makeLogger('service')
  const instance = build({ emit: writeFrame, env: loaderEnvFromProcess() })
  const decoder = createFrameDecoder()
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: Json[]
    try {
      messages = decoder.push(chunk)
    } catch (err) {
      log(`bad frame: ${(err as Error).message}`)
      return
    }
    for (const message of messages) instance.receive(message)
  })
  process.stdin.on('end', () => {
    instance.close()
    process.exit(0)
  })
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))

  log(`service started (pid ${process.pid})`)
}
