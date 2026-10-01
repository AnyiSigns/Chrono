// `ref-hydrate` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 唯一方法 `hydrate` 逐跳反向调 `host.def.read`；应答帧由 SDK `PortLink` 立即结算。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/**
 * 等待宿主 `host.def.read` 的上限。须严格小于本插件 `ref-hydrate.hydrate` 的声明超时（25000），
 * 使内层先以自身错误收口；同时小于消费方反向调用本方法的等待上限（ui-settings / ui-approval 为 30000）。
 */
const PORT_CALL_TIMEOUT_MS = 20000

export const createService = defineService({
  entry: import.meta.url,
  capability: 'ref-hydrate',
  logPrefix: 'ref-hydrate',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'ref-hydrate',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers(link),
      portLinks: [link],
    }
  },
})
