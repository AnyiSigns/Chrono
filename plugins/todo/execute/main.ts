// `todo` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 清单本体已出世界：写即时落委托存储（storage-kv），读从自有存储取。
// 反向调用（storage-kv.*）走 `port.call`，应答帧由 SDK 派发器拦截结算（不排队）。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RemoteStorage } from './port-link.ts'
import { TodoStore } from './store.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'todo'
const LOG = makeLogger('todo')

/** 构造服务实例：反向调用通道 + 委托存储，均由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'todo' })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ store: new TodoStore(new RemoteStorage(link)) }),
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => link.settle(message),
    onDrain: () => link.failAll(),
    onClose: () => link.failAll(),
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
