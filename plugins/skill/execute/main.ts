// `skill` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 技能清单已出世界：写即时落自有持久存储（④），读从自有存储取。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { SkillStore } from './store.ts'

/** 构造服务实例：④ 目录取 loader 参数，存储引擎由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'skill',
  logPrefix: 'skill',
  defaultState: 'durable',
  setup: (ctx) => ({
    handlers: createHandlers({ store: SkillStore.open(ctx.env) }),
  }),
})
