// `config` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 用户配置 / 界面配置已出世界：写即时落自有持久存储（④），读从自有存储取。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { ConfigStore } from './store.ts'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'config',
  logPrefix: 'config',
  defaultState: 'durable',
  setup: (ctx) => ({
    handlers: createHandlers({ store: ConfigStore.open(ctx.env) }),
  }),
})
