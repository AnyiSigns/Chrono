// `router` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不取时间 / 随机——select 同输入同输出。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { HANDLERS } from './methods.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'router'
const LOG = makeLogger('router')

/** 构造服务实例：方法表由本插件提供，协议壳归 SDK。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: HANDLERS,
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
