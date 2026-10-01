// `session` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；会话运行记录写自有持久存储（④），不构造世界写计划。
// 反向调用（清输入槽）走 `port.call`，应答帧立即结算（不排队）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { SessionStore } from './store.ts'

/** 构造服务实例：反向调用通道 + 会话存储，均由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'session',
  logPrefix: 'session',
  defaultState: 'durable',
  setup: (ctx) => {
    const link = new PortLink({ write: ctx.emit, idPrefix: 'session' })
    const store = SessionStore.open(ctx.env)
    return {
      handlers: createHandlers({ port: link, store }),
      portLinks: [link],
      eventIdPrefix: 'session-evt',
    }
  },
})
