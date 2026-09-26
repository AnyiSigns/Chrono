// `plugin-admin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：方法只返回值 / 写计划。
// 第二方向：服务发 `port.call`（反向调用），宿主回 `port.result` / `port.error`（按 id 配对）。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { HostLink } from './host.ts'
import { createHandlers } from './methods.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

// 多能力类插件：SDK 的 capability 只用于方法门禁的单键回落。本插件 plugin.json 声明了
// `plugin` 与 `plugin-admin` 两个能力类，故传一个非 methods 键的值，使门禁回落为处理器表键集
// （两能力类方法的并集）；能力类归属仍由 plugin.json.implements 决定。
const CAPABILITY = 'plugin+plugin-admin'
const LOG = makeLogger('plugin-admin')

/** 构造服务实例：反向调用通道 + 宿主调用包装，均由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'plugin-admin' })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers(new HostLink(link)),
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => link.settle(message),
    onDrain: () => link.failAll('transport_failed'),
    onClose: () => link.failAll('transport_failed'),
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
