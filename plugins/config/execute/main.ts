// `config` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 用户配置 / 界面配置已出世界：写即时落自有持久存储（④），读从自有存储取。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { ConfigStore } from './store.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'config'
const LOG = makeLogger('config')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    defaultState: 'durable',
    handlers: createHandlers({ store: ConfigStore.open(ctx.env) }),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
