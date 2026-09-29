// `secrets` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不缓存落盘；本地文件读取经反向 `port.call secrets-local.*`，
// `env` kind 取本服务进程环境，明文只在返回值里。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RemoteLocalSecrets } from './port-link.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'secrets'
const LOG = makeLogger('secrets')
/** 反向调用等待上限：须严格大于 secrets-local 声明的 `method_timeouts`（5000）。 */
const LOCAL_CALL_TIMEOUT_MS = 10000

/** 构造服务实例：本地读取面走反向调用，`env` kind 取本服务进程环境。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'secrets', timeoutMs: LOCAL_CALL_TIMEOUT_MS })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ local: new RemoteLocalSecrets(link), env: process.env }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
