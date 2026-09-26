// `approval` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写链通道：队列与游标写自有持久存储，方法只返回 extern 与事件。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { ApprovalStore } from './store.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'approval'
const LOG = makeLogger('approval')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    defaultState: 'durable',
    handlers: createHandlers({ store: ApprovalStore.open(ctx.env) }),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
