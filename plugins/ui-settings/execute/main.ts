// `ui-settings` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 声明的只读方法脱串行链派发（SDK intercept），其余帧由 SDK 按到达序串行；跨插件只走反向调用。

import {
  BadArgsError,
  PortLink,
  SERVICE_PROTOCOL_VERSION,
  ServiceError,
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
import { Bridge } from './bridge.ts'
import { InboundClient } from './inbound.ts'
import { createHandlers } from './methods.ts'
import type { SecretsChannel } from './methods.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'

const CAPABILITY = 'ui-settings'
const LOG = makeLogger('ui-settings')
const PLUGIN = readPluginJson(packageRootOf(import.meta.url))
const MANIFEST = deriveManifest(PLUGIN, CAPABILITY, 'recomputable')
// 允许脱离串行链派发的方法白名单（plugin.json `concurrent_methods`）。
const CONCURRENT_METHODS = new Set<string>(
  Array.isArray(PLUGIN['concurrent_methods'])
    ? (PLUGIN['concurrent_methods'] as Json[]).filter((item): item is string => typeof item === 'string')
    : [],
)

const root = rootFromPluginState(process.env, process.cwd())
const inbound = new InboundClient({ socketPath: inboundSocketPath(root), log: LOG })
const bridge = new Bridge(inbound)

/** 该帧是否应脱离串行链派发：只有 `concurrent_methods` 白名单里的 `call` 脱链。 */
function isConcurrentCall(message: Rec): boolean {
  if (message['kind'] !== 'call') return false
  const method = message['method']
  return typeof method === 'string' && CONCURRENT_METHODS.has(method)
}

/** 密钥本地存储面：经本进程入站连接直发 `secrets.put` / `secrets.delete`（不进世界 / 审计）。 */
const SECRETS: SecretsChannel = {
  put: async (name, value) => {
    const result = await bridge.secretsPut(name, value)
    return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message }
  },
  delete: async (name) => {
    const result = await bridge.secretsDelete(name)
    return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message }
  },
}

/** 构造服务实例：反向调用通道与入站桥由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'ui-settings' })
  const rawHandlers = createHandlers({
    identity: CAPABILITY,
    model: link,
    retrieval: link,
    maintenance: link,
    session: link,
    shortMemory: link,
    input: link,
    config: link,
    secrets: SECRETS,
    host: link,
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
      if (err instanceof ServiceError) {
        sendError(id, err.code, err.message)
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
      // 只读方法脱链派发：其反向调用可能长时间挂起（模型 / 记忆后端），若占着串行链会让其余命令全部排队。
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
