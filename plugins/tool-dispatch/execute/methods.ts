// 能力类 `tool-dispatch` 的方法表：`dispatch`（整批并发派发）。
// 目录装配与 args 校验均经反向 `port.call` 到 `tool-registry`，语义门经 `guard`；
// 具体工具调用扇出到各提供者，本插件不读投影、无写通道。

import { PortLink } from 'plugin-sdk'
import { dispatchBag } from './dispatch.ts'
import type { DispatchDeps } from './dispatch.ts'
import { RemoteRegistry, RemoteSchema } from './port-link.ts'
import type { CallEnv, Handler, HandlerResult, Json } from 'plugin-sdk'
import type { ResultCache } from './cache.ts'

export interface DispatchServiceDeps {
  link: PortLink
  emit: (topic: string, payload: Json) => void
  concurrency: number
  cache: ResultCache
  cacheEnabled: boolean
}

/** 构造方法表（main.ts 校验 `port` / `method` 后取用）。 */
export function createHandlers(deps: DispatchServiceDeps): Record<string, Handler> {
  const dispatchDeps: DispatchDeps = {
    link: deps.link,
    emit: deps.emit,
    registry: new RemoteRegistry(deps.link),
    schema: new RemoteSchema(deps.link),
    concurrency: deps.concurrency,
    cache: deps.cache,
    cacheEnabled: deps.cacheEnabled,
  }
  return {
    dispatch: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: await dispatchBag(args, env, dispatchDeps),
      events: [],
    }),
  }
}
