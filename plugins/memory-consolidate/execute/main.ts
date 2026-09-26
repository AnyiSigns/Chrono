// `memory-consolidate` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道；数据由调用方入口 term 或宿主 periodic.reads 装配进 args。
// 反向调用（embedding.chunk / embedding.embed / compress.summarize）走 `port.call`，应答帧立即结算。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RemoteCompress, RemoteEmbedding, RemoteMemory, RemoteSession, RemoteShortMemory } from './port-link.ts'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'memory-maintenance'
const LOG = makeLogger('memory-consolidate')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'memory-consolidate' })
  const handlers = createHandlers({
    embedding: new RemoteEmbedding(link),
    compress: new RemoteCompress(link),
    shortMemory: new RemoteShortMemory(link),
    memory: new RemoteMemory(link),
    session: new RemoteSession(link),
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
