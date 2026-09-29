// `compress` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道；读-改-写所需的世界数据由调用方随 args 传入。
// 反向调用（summarize.* / semantic.summarize / dedup.dedup / short-memory.*）走 `port.call`，
// 应答帧立即结算（不排队）。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RemoteDedup, RemoteSemantic, RemoteShortMemory, RemoteSummarize } from './port-link.ts'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'compress'
const LOG = makeLogger('compress')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'compress' })
  const handlers = createHandlers({
    summarize: new RemoteSummarize(link),
    semantic: new RemoteSemantic(link),
    dedup: new RemoteDedup(link),
    shortMemory: new RemoteShortMemory(link),
  })
  const sdkHandlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    sdkHandlers[method] = async (args, env) => ({ value: await handler(args, env), events: [] })
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: sdkHandlers,
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
