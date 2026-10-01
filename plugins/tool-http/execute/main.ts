// `tool-http` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 反向调用（sandbox.exec / host.asset.put / search-index.search|put）走 SDK `PortLink`，回带发起 call 帧 id。
// 本地索引为可选增强：`search-index` 成员表为空时后端回 `index_unavailable`，websearch 静默降级为纯网络检索。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

const CAPABILITY = 'tool-http'
const LOG = makeLogger('tool-http')

/** 构造服务实例：反向调用通道由 SDK 提供，方法表由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'tool-http' })
  const indexMembers = ctx.manyNeeds?.['search-index'] ?? []
  const rawHandlers = createHandlers(link, indexMembers)
  const handlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(rawHandlers)) {
    handlers[method] = async (args, env, call) => ({
      value: await handler(args, env, call.callId),
      events: [],
    })
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
