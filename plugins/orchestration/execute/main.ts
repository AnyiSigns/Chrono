// `orchestration` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不发 eff：机械闸经反向 `port.call graph-gate.validate` 消费提供方。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/** 反向调用等待上限（机械闸为纯函数、确定性；须小于本服务方法的 `method_timeouts`）。 */
const PORT_CALL_TIMEOUT_MS = 30000

/** 构造服务实例：方法表由本插件提供，协议壳归 SDK。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'orchestration',
  logPrefix: 'orchestration',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'orchestration',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers({ port: link }),
      portLinks: [link],
    }
  },
})
