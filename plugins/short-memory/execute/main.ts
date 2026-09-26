// `short-memory` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// L1 / L2 已出世界：写即时落自有持久存储（④），读从自有存储取。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { ShortMemoryStore } from './persist.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'short-memory'
const LOG = makeLogger('short-memory')

/** 构造服务实例：④ 目录取 loader 参数，存储引擎由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    defaultState: 'durable',
    handlers: createHandlers({ store: ShortMemoryStore.open(ctx.env) }),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
