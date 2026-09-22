// 能力类 `ui-threads` 的方法表：`ping` 健康占位 + `threads.state` 标签数据装配。
// 服务不读投影、无写通道：`threads.state` 只从入口 term 随 args 传入的 `ctx.ids` 切片里取数。
// 只返回值，不落账、不自取时钟（docs/plugins.md 服务通则）。

import { assembleThreadsState } from './threads-state.ts'
import type { Handler, Json } from './types.ts'

export interface HandlerDeps {
  identity: string
}

/** 构造方法表；main.ts 校验 `port` / `method` 后取用。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: (): { value: Json } => ({ value: { pong: true, identity: deps.identity } }),

    /** 入口 term 传 `ctx.ids`，服务装配线程标签 + 待办标签（父会话隔离）。 */
    'threads.state': (args): { value: Json } => ({ value: assembleThreadsState(args) }),
  }
}
