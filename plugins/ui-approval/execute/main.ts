// `ui-approval` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 声明为并发安全的方法（plugin.json `concurrent_methods`）由 SDK 脱串行链派发；跨插件只走反向调用。

import { fileURLToPath } from 'node:url'

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { InboundClient, inboundSocketPath, rootFromPluginState } from 'plugin-sdk/web'
import { createHandlers } from './methods.ts'

const CAPABILITY = 'ui-approval'
const LOG = makeLogger('ui-approval')

const root = rootFromPluginState(process.env, process.cwd())
/** 客户端半边根：`execute/web/`（服务按此根做包内相对路径防护）。 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url))

const inbound = new InboundClient({ socketPath: inboundSocketPath(root), log: LOG })

/** 构造服务实例：反向调用通道（approval / input）与入站客户端由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'ui-approval' })
  const rawHandlers = createHandlers({
    identity: CAPABILITY,
    approval: link,
    input: link,
    webRoot: WEB_ROOT,
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
