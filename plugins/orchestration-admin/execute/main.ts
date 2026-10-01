// `orchestration-admin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 工具面不实现编排逻辑：invoke 经反向 `port.call orchestration.*` 消费编排平面提供方。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/** 反向调用等待上限（编排平面为纯函数、确定性；validate / propose 内部再反向调用 graph-gate）。 */
const PORT_CALL_TIMEOUT_MS = 30000

/** 构造服务实例：方法表由本插件提供，协议壳归 SDK。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'orchestration-admin',
  logPrefix: 'orchestration-admin',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'orchestration-admin',
      timeoutMs: PORT_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers({ port: link }),
      portLinks: [link],
    }
  },
})
