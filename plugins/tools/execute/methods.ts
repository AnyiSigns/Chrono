// 能力类 `tools` 的方法表：`list`（出工具目录）+ `dispatch`（整批派发）——均为薄门面，
// 分别委派 `tool-registry.list` / `tool-dispatch.dispatch`，保留原 `tools` 契约与公开方法面。
// 服务不读投影、无写通道；数据随 args（bag）透传，跨插件只走反向帧 `port.call`。
// 多一跳须严格嵌套超时：门面按下游方法声明抬高单次反向等待，并回带发起帧 id（env 归属正确）。

import { BadArgsError, ServiceError, isRecord } from 'plugin-sdk'
import type { CallContext, Handler, HandlerResult, Json, PortLink, Rec } from 'plugin-sdk'

/** 门面 → `tool-registry.list` 的等待上限；严格嵌套：`tools.list`(130000) > 本值 > 下游声明(120000)。 */
export const REGISTRY_LIST_TIMEOUT_MS = 129_000

/** 门面 → `tool-dispatch.dispatch` 的等待上限；严格嵌套：`tools.dispatch`(1800000) > 本值 > 下游声明(1790000)。 */
export const DISPATCH_TIMEOUT_MS = 1_799_000

export interface ToolsDeps {
  link: PortLink
}

/** 委派一次反向调用：把 bag 形态错误转 `bad_args`，下游失败按原码透传。 */
async function delegate(
  port: string,
  method: string,
  args: Json,
  deps: ToolsDeps,
  call: CallContext,
  timeoutMs: number,
): Promise<Json> {
  if (args !== undefined && args !== null && !isRecord(args))
    throw new BadArgsError('bag must be an object')
  const bag: Rec = isRecord(args) ? args : {}
  const outcome = await deps.link.call(port, method, bag, { callId: call.callId, timeoutMs })
  if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
  return outcome.value
}

/** 构造方法表（main.ts 校验 `port` / `method` 后取用）。 */
export function createHandlers(deps: ToolsDeps): Record<string, Handler> {
  return {
    list: async (args: Json, _env, call: CallContext): Promise<HandlerResult> => ({
      value: await delegate('tool-registry', 'list', args, deps, call, REGISTRY_LIST_TIMEOUT_MS),
      events: [],
    }),
    dispatch: async (args: Json, _env, call: CallContext): Promise<HandlerResult> => ({
      value: await delegate('tool-dispatch', 'dispatch', args, deps, call, DISPATCH_TIMEOUT_MS),
      events: [],
    }),
  }
}
