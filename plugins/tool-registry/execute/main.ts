// `tool-registry` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：目录所需绑定表 / MCP 清单由调用方随 bag 传入；describe 与 schema 校验走反向帧。

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

const CAPABILITY = 'tool-registry'
const LOG = makeLogger('tool-registry')

/** 构造服务实例：反向调用通道由本插件提供；目录装配重逻辑住本提供方。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'tool-registry' })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({
      link,
      pins: ctx.pins === undefined ? [] : Object.keys(ctx.pins),
      manyProviders: ctx.manyNeeds?.['tool-provider'] ?? [],
    }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
