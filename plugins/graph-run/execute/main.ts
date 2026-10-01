// `graph-run` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 反向调用（节点能力类）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/**
 * 反向调用等待上限。须严格大于被调用层最长的 `method_timeouts`——模型调用 `model.chat` 3600000
 * （经 agent.step / subagent / evolve.propose 抵达），否则本层先超时、内层安全网还没机会自收口；
 * 同时严格小于本层宿主侧的 `graph-run.run` 安全网（4000000）。
 */
const PORT_CALL_TIMEOUT_MS = 3950000

export const createService = defineService({
  entry: import.meta.url,
  capability: 'graph-run',
  logPrefix: 'graph-run',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'graph-run',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers({
        port: link,
        pins: ctx.pins,
        contextSources: ctx.manyNeeds?.['context-source'] ?? [],
        ruleProviders: ctx.manyNeeds?.['loop-rule'] ?? [],
        turnHooks: ctx.manyNeeds?.['turn-hook'] ?? [],
      }),
      portLinks: [link],
    }
  },
})
