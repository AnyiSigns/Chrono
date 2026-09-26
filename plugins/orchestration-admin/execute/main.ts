// `orchestration-admin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不发 eff：方法只返回值 / 写计划。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

// 多能力类插件：门禁按帧内 `port` 逐能力类取 plugin.json.methods 的方法集；
// capability 只作缺声明时的回落，取主能力类即可。
const CAPABILITY = 'orchestration'
const LOG = makeLogger('orchestration-admin')

/** 构造服务实例：方法表由本插件提供，协议壳归 SDK。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers(),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
