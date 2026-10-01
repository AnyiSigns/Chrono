// `input` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 输入槽运行记录写自有持久存储（④ `CHRONO_PLUGIN_DATA`）。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { InputStore } from './store.ts'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'input',
  logPrefix: 'input',
  defaultState: 'durable',
  setup: (ctx) => ({
    handlers: createHandlers({ store: InputStore.open(ctx.env) }),
  }),
})
