// `ui-notify` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// 本插件仍是浏览器侧 headless 前端（`web/entry.js`，不占 slot、不给端口）；此服务只做一件事：
// 经 `ui-slot.list` 自声明 headless 入口，令壳不再内置 `ui-notify` 的默认挂载——
// 增删本插件只改世界成员表 / 本包，不改 `ui-shell` 源码。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。

import {
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'ui-notify'
const LOG = makeLogger('ui-notify')

/** headless 入口：不占 slot、不给布局位；壳经 `host.source.read` 取字节后同源服务。 */
const HEADLESS_ENTRY = 'web/entry.js'

/** 构造服务实例：健康占位与 `ui-slot` headless 自声明。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: {
      ping: () => ({ value: { pong: true, identity: CAPABILITY }, events: [] }),
      // `ui-slot` 提供方：自声明 headless 清单条目。
      list: () => ({
        value: { headless: [{ id: CAPABILITY, entry: HEADLESS_ENTRY }] },
        events: [],
      }),
    },
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
