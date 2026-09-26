// `session` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；会话运行记录写自有持久存储（④），不构造世界写计划。
// 反向调用（清输入槽）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { SessionStore } from './store.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'session'
const LOG = makeLogger('session')

/** 构造服务实例：反向调用通道 + 会话存储，均由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'session' })
  const store = SessionStore.open(ctx.env)
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    defaultState: 'durable',
    handlers: createHandlers({ port: link, store }),
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => link.settle(message),
    onDrain: () => link.failAll(),
    onClose: () => link.failAll(),
    drainExitMs: 10,
    eventIdPrefix: 'session-evt',
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
