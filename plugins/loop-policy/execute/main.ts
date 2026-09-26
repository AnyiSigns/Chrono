// `loop-policy` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 反向调用（节点能力类）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'loop-policy'
const LOG = makeLogger('loop-policy')
/** 反向调用等待上限；宿主另有 `method_timeouts` 覆盖 `interpret`。 */
const PORT_CALL_TIMEOUT_MS = 600000

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'loop-policy', timeoutMs: PORT_CALL_TIMEOUT_MS })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ port: link, host: link }),
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => link.settle(message),
    onDrain: () => link.failAll(),
    onClose: () => link.failAll(),
    drainExitMs: 10,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
