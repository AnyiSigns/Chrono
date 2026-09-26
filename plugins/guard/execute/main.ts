// `guard` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不取时间 / 随机——judge 同输入同输出。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { HANDLERS } from './methods.ts'
import type { Handler, Json, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'guard'
const LOG = makeLogger('guard')

/** 把同步业务处理器（args 进、值出）适配为 SDK 处理器（值 + 空事件）。 */
function sdkHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(HANDLERS)) {
    handlers[method] = (args: Json) => ({ value: handler(args), events: [] })
  }
  return handlers
}

function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: sdkHandlers(),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
