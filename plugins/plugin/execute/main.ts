// `plugin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：方法只返回值 / 写计划。
// 第二方向：服务发 `port.call`（反向调用），宿主回 `port.result` / `port.error`（按 id 配对）。

import { PortLink, defineService } from 'plugin-sdk'
import { HostLink } from './host.ts'
import { createHandlers } from './methods.ts'

/** 构造服务实例：反向调用通道 + 宿主调用包装，均由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'plugin',
  logPrefix: 'plugin',
  setup: (ctx) => {
    const link = new PortLink({ write: ctx.emit, idPrefix: 'plugin' })
    return {
      handlers: createHandlers(new HostLink(link)),
      portLinks: [link],
    }
  },
})
