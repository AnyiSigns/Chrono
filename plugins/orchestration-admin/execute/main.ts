// `orchestration-admin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 工具面不实现编排逻辑：invoke 经反向 `port.call orchestration.*` 消费编排平面提供方。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'orchestration-admin'
const LOG = makeLogger('orchestration-admin')

/** 反向调用等待上限（编排平面为纯函数、确定性；validate / propose 内部再反向调用 graph-gate）。 */
const PORT_CALL_TIMEOUT_MS = 30000

/** 构造服务实例：方法表由本插件提供，协议壳归 SDK。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({
    write: ctx.emit,
    idPrefix: 'orchestration-admin',
    timeoutMs: PORT_CALL_TIMEOUT_MS,
  })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ port: link }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
