// `ui-threads` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影：标签数据由入口 term 读 `ctx.ids` 随 args 传入；客户端半边由本进程读包内产物回字节。

import { fileURLToPath } from 'node:url'

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

const CAPABILITY = 'ui-threads'
const LOG = makeLogger('ui-threads')

/** 客户端半边资产根目录（`execute/web/`）；`client.read` 只在此目录内解析包内相对 `.js`。 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url))

/** 构造服务实例：反向调用通道（`host.def.read`）由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'ui-threads' })
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({ identity: CAPABILITY, webRoot: WEB_ROOT, host: link }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
