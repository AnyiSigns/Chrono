// 服务派发器与三形态入口：stdio 下起帧循环，inproc / worker 下由宿主 import 后直调。
// 同一份派发逻辑，故三种 transport 对同一组调用产出逐字节一致的结果与事件。
// manifest 从同包 plugin.json 派生；能力 / 方法 / args 形态门禁与错误映射集中在此。
// 反向调用通道、并发方法声明、多能力类门禁与 drain 收口均由本模块吸收，插件只写方法实现。

import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCallEnv } from './env.ts'
import { isRecord } from './json.ts'
import { declaredMethods, deriveManifest, readPluginJson } from './manifest.ts'
import { settlePortLinks } from './port-link.ts'
import { canonicalJson } from './canonical.ts'
import {
  createFrameDecoder,
  writeFrame,
  MAX_FRAME_BYTES,
  SERVICE_PROTOCOL_VERSION,
} from './wire.ts'
import { BadArgsError, ServiceError } from './types.ts'
import type { Json, Rec } from './json.ts'
import type { PortLink } from './port-link.ts'
import type { ServiceManifest } from './manifest.ts'
import type { CallContext, CallEnv, Handler, ServiceEvent } from './types.ts'

/** 宿主 loader 传给同语言入口的上下文（与 assembly/service-host.ts 的 ServiceFactoryContext 同形）。 */
export interface ServiceFactoryContext {
  /** 服务 → 宿主发一帧。 */
  emit: (message: Json) => void
  /** ③ / ④ 目录（只含已注入项）。 */
  env: Record<string, string>
  /**
   * 宿主注入的**有效 pins**（该身份代码世代 `needs` 的 `one` 绑定派生）；未注入时缺席。
   * stdio 由宿主经 spawn env `CHRONO_PLUGIN_PINS` 注入、SDK 从进程 env 解析；inproc / worker
   * 由宿主经工厂 ctx 原样传入（SDK 不吞）。
   */
  pins?: Record<string, string>
  /**
   * 宿主按世界能力索引注入的 **`many` 成员表**（`cap → [提供方身份名]`，码元序）：该身份
   * `needs` 中 `mode:"many"` 的能力类 → 其世界提供方。stdio 由宿主经 spawn env
   * `CHRONO_PLUGIN_MANY_NEEDS` 注入、SDK 从进程 env 解析；inproc / worker 由工厂 ctx 传入。
   */
  manyNeeds?: Record<string, string[]>
}

export interface ServiceConfig {
  /** 插件包根目录（含 `plugin.json`）。 */
  pluginRoot: string
  /** 本服务的能力类名（缺声明时的回落；门禁按帧内 `port` 逐能力类判定）。 */
  capability: string
  /** 方法表：方法名 → 处理器。 */
  handlers: Record<string, Handler>
  /** 发帧出口。 */
  emit: (message: Json) => void
  /** 缺省状态档；`plugin.json` 缺 `state` 时用。 */
  defaultState?: string
  /** 日志出口（stderr）；缺省以 identity 为前缀。 */
  log?: (line: string) => void
  /**
   * 反向调用通道：SDK 自动结算其应答帧（`port.result` / `port.error`），
   * 并在 `drain` / 通道关闭时 `failAll`，插件无需自写 `intercept` 结算。
   */
  portLinks?: PortLink[]
  /**
   * 并发安全方法：这些方法的 `call` 脱出串行链、彼此可并发。
   * 缺省读同包 `plugin.json` 的 `concurrent_methods`；两者皆无则全部串行。
   */
  concurrentMethods?: string[]
  /** 帧进入派发前的拦截（插件自有扩展面）；返回 true 表示已消费。 */
  intercept?: (message: Rec) => boolean
  /** `reload` 帧钩子：数据热生效时重载插件自有配置；在回 `ack` 前调用。 */
  onReload?: (gen: string) => void
  /** `drain` 帧后的清理钩子（可异步；SDK 等它落地后才收口）。 */
  onDrain?: () => void | Promise<void>
  /** 通道关闭 / stdin EOF 时的清理钩子。 */
  onClose?: () => void
  /** 事件帧 id 前缀；缺省 `<identity>-evt`。 */
  eventIdPrefix?: string
}

/** 日志出口：一行一条，只走 stderr。 */
export type ServiceLog = (line: string) => void

/** 一个已装载的服务实例：收协议帧、可关闭。 */
export interface ServiceInstance {
  receive(message: Json): void
  close(): void
  /** `drain` 清理完成后 resolve；stdio 形态据此在 `bye` 后收口退出。 */
  readonly drained?: Promise<void>
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

/**
 * 从 `process.env.CHRONO_PLUGIN_PINS` 解析宿主注入的有效 pins（stdio 形态）；
 * 缺失 / 坏 JSON / 非字符串映射一律回落 `undefined`（不抛，服务可回落到空表）。
 */
export function pinsFromProcess(): Record<string, string> | undefined {
  const raw = process.env['CHRONO_PLUGIN_PINS']
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const out: Record<string, string> = {}
  for (const key of Object.keys(parsed)) {
    const value = parsed[key]
    if (typeof value !== 'string') return undefined
    out[key] = value
  }
  return out
}

/**
 * 从 `process.env.CHRONO_PLUGIN_MANY_NEEDS` 解析宿主注入的 `many` 成员表（stdio 形态）；
 * 缺失 / 坏 JSON / 形不合一律回落 `undefined`（不抛，服务可回落到本地声明）。
 */
export function manyNeedsFromProcess(): Record<string, string[]> | undefined {
  const raw = process.env['CHRONO_PLUGIN_MANY_NEEDS']
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const out: Record<string, string[]> = {}
  for (const key of Object.keys(parsed)) {
    const value = parsed[key]
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined
    out[key] = value as string[]
  }
  return out
}

/** 本模块是否被直接运行（stdio 形态）；被 import 时（inproc / worker）为 false。 */
export function isDirectRun(importMetaUrl: string): boolean {
  const argv1 = process.argv[1]
  return argv1 !== undefined && importMetaUrl === pathToFileURL(argv1).href
}

/** 取字符串数组；形态不合回落空表。 */
function stringList(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

/**
 * 构造一个与 transport 无关的服务实例。
 * stdio 由 `runStdio` 喂入 stdin 帧；inproc / worker 由宿主把帧交给 `receive`。
 */
export function createService(config: ServiceConfig): ServiceInstance {
  const plugin = readPluginJson(config.pluginRoot)
  const manifest = deriveManifest(plugin, config.capability, config.defaultState ?? 'recomputable')
  const declaredCache = new Map<string, Set<string>>()
  const portLinks = config.portLinks ?? []
  const concurrentMethods = new Set<string>(
    config.concurrentMethods ?? stringList(plugin['concurrent_methods']),
  )
  const emit = config.emit
  const log = config.log ?? makeLogger(manifest.identity)
  const eventIdPrefix = config.eventIdPrefix ?? `${manifest.identity}-evt`
  let eventSeq = 0
  let chain: Promise<void> = Promise.resolve()
  let resolveDrained: () => void = () => {}
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve
  })
  /** 脱链并发调用的在途集合：drain 前等它们落地。 */
  const inflight = new Set<Promise<void>>()

  function sendError(id: string, code: string, message: string): void {
    emit({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'error', ok: false, code, message })
  }

  /**
   * 回结果帧；编码后超单帧上限则改回 `response_too_large` 错误帧。
   * 结果帧若大到写出即被对端判脏帧，会把整条通道升级成协议损坏；此处先行预检，让超限成为
   * 协议内**可辨、可重试**的失败，而不是通道坍塌。
   */
  function sendResult(id: string, value: Json): void {
    const message: Rec = { v: SERVICE_PROTOCOL_VERSION, id, kind: 'result', ok: true, value }
    let size: number
    try {
      size = Buffer.byteLength(canonicalJson(message), 'utf8')
    } catch {
      sendError(id, 'internal', 'result not serializable')
      return
    }
    if (size > MAX_FRAME_BYTES) {
      sendError(id, 'response_too_large', 'result exceeds frame limit')
      return
    }
    emit(message)
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

  /** 某能力类声明的方法集：plugin.json 按能力类声明优先，缺声明回落处理器表键集。 */
  function declaredFor(port: string): Set<string> {
    let set = declaredCache.get(port)
    if (set === undefined) {
      set = declaredMethods(manifest, port, config.handlers)
      declaredCache.set(port, set)
    }
    return set
  }

  /** 帧是否声明为并发安全方法调用：只认 `call` 帧；声明集来自 `concurrent_methods`。 */
  function isConcurrentCall(message: Rec): boolean {
    return (
      message['kind'] === 'call' &&
      typeof message['method'] === 'string' &&
      concurrentMethods.has(message['method'])
    )
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
    if (!declaredFor(port).has(method)) {
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
    const call: CallContext = { callId: id, port, method, env }
    try {
      const result = await handler(rawArgs ?? null, env, call)
      sendEvents(result.events)
      sendResult(id, result.value)
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

  /** 脱链并发调用：不排串行链，但登记在途供 drain 等待。 */
  function dispatchConcurrent(message: Rec): void {
    const pending = handleCall(message)
    inflight.add(pending)
    void pending.finally(() => inflight.delete(pending))
  }

  async function handleDrain(message: Rec): Promise<void> {
    await Promise.allSettled([...inflight])
    emit({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'bye' })
    for (const link of portLinks) link.failAll()
    try {
      await config.onDrain?.()
    } catch (err) {
      log(`onDrain failed: ${(err as Error).message}`)
    }
    resolveDrained()
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
        config.onReload?.(typeof message['gen'] === 'string' ? message['gen'] : '')
        log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
        emit({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'ack' })
        return
      case 'drain':
        return handleDrain(message)
      case 'call':
        return handleCall(message)
      default:
        return
    }
  }

  function handle(message: Json): void {
    if (!isRecord(message)) return
    if (portLinks.length > 0 && settlePortLinks(portLinks, message)) return
    if (config.intercept?.(message) === true) return
    if (isConcurrentCall(message)) {
      dispatchConcurrent(message)
      return
    }
    chain = chain
      .then(() => handleOne(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }

  return {
    receive(message: Json): void {
      handle(message)
    },
    close(): void {
      for (const link of portLinks) link.failAll()
      config.onClose?.()
    },
    drained,
  }
}

/** stdio 形态选项。 */
export interface RunStdioOptions {
  /** 日志出口。 */
  log?: (line: string) => void
  /**
   * 坏帧（坏 JSON / 超长帧）处理：`ignore`（缺省）记日志后继续，`exit` fail-closed 退出非 0。
   * 缺省保持存量行为；需要「协议损坏即退出」的服务显式选 `exit`。
   */
  onMalformedFrame?: 'ignore' | 'exit'
}

/**
 * stdio 形态入口：起 stdin 帧循环、stdout 只发协议帧，stdin EOF / 管道断开即自退出。
 * 收到 `bye`（drain 收口）后，等实例的 drain 清理落地再退出——进程生命周期归本形态，
 * 故 inproc / worker 的 `createService` 不退出进程（由宿主的执行体 teardown 负责）。
 * @param build 用 stdio 出口与进程 env 构造服务实例的工厂
 * @param options 日志出口与坏帧处理
 */
export function runStdio(
  build: (ctx: ServiceFactoryContext) => ServiceInstance,
  options: RunStdioOptions = {},
): void {
  const log = options.log ?? makeLogger('service')
  const failClosed = options.onMalformedFrame === 'exit'
  let instance: ServiceInstance | null = null
  let closing = false
  const emit = (message: Json): void => {
    if (instance !== null && !closing && isRecord(message) && message['kind'] === 'bye') {
      closing = true
      const done = instance.drained ?? Promise.resolve()
      void done.then(
        () => process.exit(0),
        () => process.exit(0),
      )
    }
    writeFrame(message)
  }
  instance = build({
    emit,
    env: loaderEnvFromProcess(),
    pins: pinsFromProcess(),
    manyNeeds: manyNeedsFromProcess(),
  })
  const decoder = createFrameDecoder()
  process.stdin.on('data', (chunk: Buffer) => {
    // 坏 JSON 帧已被解码器消费，重试可继续解同块内剩余帧；超长帧未被消费，不可重试。
    let pending: Buffer | null = chunk
    while (pending !== null) {
      try {
        const messages = decoder.push(pending)
        for (const message of messages) instance?.receive(message)
        pending = null
      } catch (err) {
        log(`bad frame: ${(err as Error).message}`)
        if (failClosed) process.exit(1)
        pending = (err as Error).message === 'frame_too_large' ? null : Buffer.alloc(0)
      }
    }
  })
  process.stdin.on('end', () => {
    instance?.close()
    process.exit(0)
  })
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))

  log(`service started (pid ${process.pid})`)
}

/** 插件业务装配结果：处理器与协议钩子。 */
export interface ServiceSetup {
  /** 方法表：方法名 → 处理器。 */
  handlers: Record<string, Handler>
  /**
   * 反向调用通道：SDK 自动结算其应答帧并在 `drain` / 关闭时 `failAll`，
   * 插件无需自写 `intercept` 结算。
   */
  portLinks?: PortLink[]
  /** 并发安全方法；缺省读同包 `plugin.json` 的 `concurrent_methods`。 */
  concurrentMethods?: string[]
  /** 帧进入派发前的拦截（插件自有扩展面）；返回 true 表示已消费。 */
  intercept?: (message: Rec) => boolean
  /** `reload` 帧钩子；在回 `ack` 前调用。 */
  onReload?: (gen: string) => void
  /** `drain` 帧后的清理钩子（可异步；SDK 等它落地后才收口）。 */
  onDrain?: () => void | Promise<void>
  /** 通道关闭 / stdin EOF 时的清理钩子。 */
  onClose?: () => void
  /** 事件帧 id 前缀；缺省 `<identity>-evt`。 */
  eventIdPrefix?: string
}

/**
 * 服务入口定义：把入口壳的一大段样板（包根 / 日志 / 工厂 / stdio 自启动）收成一处声明。
 * 插件只写 `setup` 里的处理器与钩子。
 */
export interface ServiceDefinition {
  /** 入口模块 URL（`import.meta.url`）：据以定位包根与判定 direct-run。 */
  entry: string
  /** 本服务的能力类名（缺声明时的回落；门禁按帧内 `port` 逐能力类判定）。 */
  capability: string
  /** 日志前缀；缺省 capability。与 `log` 二选一（给出 `log` 时忽略本项）。 */
  logPrefix?: string
  /** 自定义日志出口；缺省 `makeLogger(logPrefix ?? capability)`。 */
  log?: ServiceLog
  /** 缺省状态档；`plugin.json` 缺 `state` 时用。 */
  defaultState?: string
  /**
   * stdio 坏帧（坏 JSON / 超长帧）处理：`ignore`（缺省）记日志后继续，`exit` fail-closed 退出非 0。
   */
  onMalformedFrame?: 'ignore' | 'exit'
  /** direct-run 起完 stdio 帧循环后的回调（仅 stdio 形态）。 */
  onStarted?: (log: ServiceLog) => void
  /** 构造处理器与协议钩子；插件业务逻辑在此。 */
  setup: (ctx: ServiceFactoryContext, capability: string, log: ServiceLog) => ServiceSetup
}

/**
 * 声明式服务入口：吸收服务入口壳样板（包根 / 日志 / 工厂 / direct-run 自起 stdio），
 * 返回宿主 inproc / worker 直接调用的 `createService` 工厂。
 * 插件只写 `setup`（处理器与协议钩子），行为与手写入口逐项一致。
 */
export function defineService(
  definition: ServiceDefinition,
): (ctx: ServiceFactoryContext) => ServiceInstance {
  const log = definition.log ?? makeLogger(definition.logPrefix ?? definition.capability)
  const pluginRoot = packageRootOf(definition.entry)

  function factory(ctx: ServiceFactoryContext): ServiceInstance {
    const setup = definition.setup(ctx, definition.capability, log)
    return createService({
      pluginRoot,
      capability: definition.capability,
      handlers: setup.handlers,
      emit: ctx.emit,
      log,
      defaultState: definition.defaultState,
      portLinks: setup.portLinks,
      concurrentMethods: setup.concurrentMethods,
      intercept: setup.intercept,
      onReload: setup.onReload,
      onDrain: setup.onDrain,
      onClose: setup.onClose,
      eventIdPrefix: setup.eventIdPrefix,
    })
  }

  if (isDirectRun(definition.entry)) {
    const options: RunStdioOptions = { log }
    if (definition.onMalformedFrame !== undefined) {
      options.onMalformedFrame = definition.onMalformedFrame
    }
    runStdio(factory, options)
    definition.onStarted?.(log)
  }

  return factory
}
