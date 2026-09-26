// `ui-settings` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 声明为并发安全的方法（plugin.json `concurrent_methods`）由 SDK 脱串行链派发；跨插件只走反向调用。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { Bridge } from './bridge.ts'
import { InboundClient } from './inbound.ts'
import { createHandlers } from './methods.ts'
import type { SecretsChannel } from './methods.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'

const CAPABILITY = 'ui-settings'
const LOG = makeLogger('ui-settings')

const root = rootFromPluginState(process.env, process.cwd())
const inbound = new InboundClient({ socketPath: inboundSocketPath(root), log: LOG })
const bridge = new Bridge(inbound)

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
  const handlers: Record<string, Handler> = {}
  for (const [name, handler] of Object.entries(rawHandlers)) {
    handlers[name] = async (args, env) => ({ value: await handler(args, env), events: [] })
  }
  const close = (): void => {
    inbound.close()
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
    onDrain: close,
    onClose: close,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}

inbound.start()
