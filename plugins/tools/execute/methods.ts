// 能力类 `tools` 的方法表：`list`（出工具目录）+ `dispatch`（整批并发派发）。
// 服务不读投影、无写通道：目录所需绑定表 / MCP 清单、执行根与 tier 全由调用方随 bag 传入；
// 对提供者 / guard / 能力类方法 / host 的调用走反向帧 `port.call`（docs/protocol.md §2.4）。

import { buildDirectory } from './directory.ts'
import { dispatchBag } from './dispatch.ts'
import type { DispatchDeps } from './dispatch.ts'
import { PINS } from './plugin.ts'
import { BadArgsError, isRecord } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

export interface ToolsDeps {
  link: DispatchDeps['link']
  emit: DispatchDeps['emit']
  concurrency: DispatchDeps['concurrency']
  cache: DispatchDeps['cache']
  cacheEnabled: DispatchDeps['cacheEnabled']
  pins?: string[]
}

/** `list(bag)`：出工具目录 = describe/invoke 提供者并集 + 绑定表 + 外部 MCP 工具（校验 / 去重后）。 */
async function listTool(args: Json, deps: ToolsDeps, pins: string[]): Promise<Json> {
  if (args !== undefined && args !== null && !isRecord(args)) throw new BadArgsError('bag must be an object')
  const bag: Rec = isRecord(args) ? args : {}
  const directory = await buildDirectory({ pins, bag, link: deps.link })
  return {
    tools: directory.tools.map((entry) => entry.decl) as unknown as Json,
    rejected: directory.rejected as unknown as Json,
  }
}

/** 构造方法表（main.ts 校验 `port` / `method` 后取用）。 */
export function createHandlers(deps: ToolsDeps): Record<string, Handler> {
  const pins = deps.pins ?? PINS
  const dispatchDeps: DispatchDeps = {
    link: deps.link,
    emit: deps.emit,
    pins,
    concurrency: deps.concurrency,
    cache: deps.cache,
    cacheEnabled: deps.cacheEnabled,
  }
  return {
    list: async (args: Json, _env: CallEnv): Promise<HandlerResult> => ({ value: await listTool(args, deps, pins) }),
    dispatch: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: await dispatchBag(args, env, dispatchDeps),
    }),
  }
}
