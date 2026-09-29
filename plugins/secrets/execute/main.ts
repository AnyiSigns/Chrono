// `secrets` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不缓存落盘；按 auth_ref.kind 定位 secrets-backend 成员，
// 经反向 `port.call` 反调其 read / list；明文只在返回值里。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { SecretBackends, SECRETS_BACKEND } from './port-link.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'secrets'
const LOG = makeLogger('secrets')
/** 反向调用等待上限：须严格大于后端声明的 `method_timeouts`（5000）；一次 resolve 可能多跳 kinds。 */
const BACKEND_CALL_TIMEOUT_MS = 10000

/** 构造服务实例：后端成员表由宿主按世界能力索引注入，定位与反调均走反向帧。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({
    write: ctx.emit,
    idPrefix: 'secrets',
    timeoutMs: BACKEND_CALL_TIMEOUT_MS,
  })
  const backends = new SecretBackends(link, ctx.manyNeeds?.[SECRETS_BACKEND] ?? [])
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ backends }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
