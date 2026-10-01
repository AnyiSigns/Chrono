// `loop-policy` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 反向调用（节点能力类）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/**
 * 反向调用等待上限。须严格大于被调用层最长的 `method_timeouts`——`graph-run.run` 4000000
 * （内层再嵌模型调用 `model.chat` 3600000），否则本层先超时、内层安全网还没机会自收口；
 * 同时严格小于本层 `interpret` 的安全网（6000000）。
 */
const PORT_CALL_TIMEOUT_MS = 4200000

export const createService = defineService({
  entry: import.meta.url,
  capability: 'loop-policy',
  logPrefix: 'loop-policy',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'loop-policy',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers({ port: link, pins: ctx.pins }),
      portLinks: [link],
    }
  },
})
