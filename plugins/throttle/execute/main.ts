// `throttle` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 令牌桶状态落本插件 ③ 目录（可重算）；无反向调用、不读投影、无写通道。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RateLimiter, rateLimitFile } from './throttle.ts'

/** 构造服务实例：单例令牌桶（③ 目录可重算）+ 四个纯决策方法。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'throttle',
  logPrefix: 'throttle',
  defaultState: 'recomputable',
  setup: (ctx) => {
    const limiter = new RateLimiter(rateLimitFile(ctx.env))
    return { handlers: createHandlers({ limiter }) }
  },
})
