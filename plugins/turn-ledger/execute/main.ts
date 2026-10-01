// `turn-ledger` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 反向调用（机械闸 / 影子回放 / 审批）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/**
 * 反向调用等待上限。须严格大于被调用层最长的 `method_timeouts`（`evolve-metrics.shadow` 180000 /
 * `graph-gate.validate` 30000 / `approval.enqueue`），同时严格小于本层宿主侧安全网
 * （`turn-ledger.settle` 600000）。
 */
const PORT_CALL_TIMEOUT_MS = 400000

export const createService = defineService({
  entry: import.meta.url,
  capability: 'turn-ledger',
  logPrefix: 'turn-ledger',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'turn-ledger',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers({ port: link, pins: ctx.pins }),
      portLinks: [link],
    }
  },
})
