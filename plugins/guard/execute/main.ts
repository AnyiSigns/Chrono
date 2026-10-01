// `guard` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不取时间 / 随机——judge 同输入同输出。

import { defineService } from 'plugin-sdk'
import { HANDLERS } from './methods.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 把同步业务处理器（args 进、值出）适配为 SDK 处理器（值 + 空事件）。 */
function sdkHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(HANDLERS)) {
    handlers[method] = (args: Json) => ({ value: handler(args), events: [] })
  }
  return handlers
}

export const createService = defineService({
  entry: import.meta.url,
  capability: 'guard',
  logPrefix: 'guard',
  setup: () => ({ handlers: sdkHandlers() }),
})
