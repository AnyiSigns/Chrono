// `ui-approval` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 声明的只读方法脱串行链派发（SDK intercept），其余帧由 SDK 按到达序串行；跨插件只走反向调用。

import { fileURLToPath } from 'node:url'

import {
  BadArgsError,
  PortLink,
  SERVICE_PROTOCOL_VERSION,
  createService as createSdkService,
  declaredMethods,
  deriveManifest,
  isDirectRun,
  isRecord,
  makeLogger,
  packageRootOf,
  parseCallEnv,
  readPluginJson,
  runStdio,
} from 'plugin-sdk'
import type { HandlerResult, Json, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { InboundClient } from './inbound.ts'
import { createHandlers } from './methods.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'

const CAPABILITY = 'ui-approval'
const LOG = makeLogger('ui-approval')
const PLUGIN = readPluginJson(packageRootOf(import.meta.url))
const MANIFEST = deriveManifest(PLUGIN, CAPABILITY, 'recomputable')
// 并发安全方法声明：仅对「纯只读、无插件内可变状态」的方法生效（list 反查、client.read 读包内文件）。
const CONCURRENT_METHODS = new Set<string>(
  Array.isArray(PLUGIN['concurrent_methods'])
    ? (PLUGIN['concurrent_methods'] as Json[]).filter((item): item is string => typeof item === 'string')
    : [],
)

const root = rootFromPluginState(process.env, process.cwd())
/** 客户端半边根：`execute/web/`（服务按此根做包内相对路径防护）。 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url))

const inbound = new InboundClient({ socketPath: inboundSocketPath(root), log: LOG })

/** 是否为声明为并发安全的方法调用；只认 `call` 帧，声明集见 plugin.json `concurrent_methods`。 */
function isConcurrentCall(message: Rec): boolean {
  return (
    message['kind'] === 'call' &&
    typeof message['method'] === 'string' &&
    CONCURRENT_METHODS.has(message['method'])
  )
}

/** 构造服务实例：反向调用通道（approval / input）与入站客户端由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'ui-approval' })
  const rawHandlers = createHandlers({
    identity: CAPABILITY,
    approval: link,
    input: link,
    webRoot: WEB_ROOT,
  })
  const declared = declaredMethods(MANIFEST, CAPABILITY, rawHandlers)

  const send = (message: Json): void => {
    try {
      ctx.emit(message)
    } catch (err) {
      LOG(`write frame failed: ${(err as Error).message}`)
    }
  }
  const sendError = (id: string, code: string, message: string): void => {
    send({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'error', ok: false, code, message })
  }

  /** 脱链派发一条并发安全调用：门禁与错误映射同 SDK 派发器，但不等串行链。 */
  async function dispatchConcurrent(message: Rec): Promise<void> {
    const id = typeof message['id'] === 'string' ? (message['id'] as string) : ''
    const port = message['port']
    const method = message['method']
    if (typeof port !== 'string' || typeof method !== 'string') {
      sendError(id, 'bad_args', 'port and method must be strings')
      return
    }
    if (!MANIFEST.implements.includes(port)) {
      sendError(id, 'unresolved_cap', `unknown capability ${port}`)
      return
    }
    if (!declared.has(method)) {
      sendError(id, 'unknown_method', `unknown method ${method}`)
      return
    }
    const handler = rawHandlers[method]
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
      const value = await handler(args ?? null, parseCallEnv(message['env']))
      send({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'result', ok: true, value })
    } catch (err) {
      if (err instanceof BadArgsError) {
        sendError(id, 'bad_args', err.message)
        return
      }
      LOG(`method ${method} failed: ${(err as Error).message}`)
      sendError(id, 'internal', 'handler failed')
    }
  }

  const handlers: Record<string, (args: Json, env: import('plugin-sdk').CallEnv) => Promise<HandlerResult>> = {}
  for (const [name, handler] of Object.entries(rawHandlers)) {
    handlers[name] = async (args, env) => ({ value: await handler(args, env), events: [] })
  }

  const close = (): void => {
    link.failAll()
    inbound.close()
  }

  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => {
      if (link.settle(message)) return true
      // 声明的纯只读方法不排串行链：它们不写插件内状态、不发世界写计划，却会反向调用长跑的
      // 相邻端口（如 approval 的 sweep 占住通道）。若也排链，一次长跑会连带堵死本插件整个命令面。
      if (isConcurrentCall(message)) {
        void dispatchConcurrent(message)
        return true
      }
      return false
    },
    onDrain: close,
    onClose: close,
    drainExitMs: 10,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}

inbound.start()
