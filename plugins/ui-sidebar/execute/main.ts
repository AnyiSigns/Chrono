// `ui-sidebar` 服务进程入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影：入口 term 把 `ctx.ids` 随 args 传入，服务装配后经宿主反向调用（`port.call`）
// 转给 `session` / `workspace`（见 execute/methods.ts）。
// 客户端半边改由插件自交付（`ui-sidebar.client.read` 读包内产物），本服务不再开 HTTP 面。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { CallEnv, Handler, Json, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { InboundClient, inboundSocketPath, rootFromPluginState } from 'plugin-sdk/web'
import { createHandlers } from './methods.ts'
import type { MethodHandler } from './methods.ts'

const CAPABILITY = 'ui-sidebar'
const LOG = makeLogger('ui-sidebar')

/** 宿主根目录与入站 socket：与其它 UI 插件同源（`plugin-sdk/web`）。 */
const root = rootFromPluginState(process.env, process.cwd())
const inbound = new InboundClient({ socketPath: inboundSocketPath(root), log: LOG })

/** 把方法表（原始业务值）包成 SDK 处理器形态（`{value, events}`）。 */
function toServiceHandlers(raw: Record<string, MethodHandler>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  for (const [name, fn] of Object.entries(raw)) {
    handlers[name] = async (args: Json, env: CallEnv) => ({ value: await fn(args, env), events: [] })
  }
  return handlers
}

/** 构造服务实例：反向调用通道（`session` / `workspace` / `input` / `host`）由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'ui-sidebar' })
  const raw = createHandlers({
    identity: CAPABILITY,
    session: link,
    workspace: link,
    input: link,
    host: link,
  })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: toServiceHandlers(raw),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
    onDrain: () => {
      inbound.close()
    },
    onClose: () => {
      inbound.close()
    },
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}

inbound.start()
LOG(`ui-sidebar ready (pid ${process.pid})`)
