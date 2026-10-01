// `approval` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写链通道：队列与游标写自有持久存储，方法只返回 extern 与事件。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { ApprovalStore } from './store.ts'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'approval',
  logPrefix: 'approval',
  defaultState: 'durable',
  setup: (ctx) => ({
    handlers: createHandlers({ store: ApprovalStore.open(ctx.env) }),
  }),
})
