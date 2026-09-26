// 服务内部共享类型与结构化失败：JSON 面、args 形态错误、调用帧 env 由 plugin-sdk 提供。

export { BadArgsError, isRecord as isRec } from 'plugin-sdk'
export type { CallEnv, Json, Rec } from 'plugin-sdk'

/** 工具调用的结构化失败：作数据回给派发方，不炸本轮。 */
export interface ToolFailure {
  ok: false
  error: { code: string; message: string } & Rec
}

/** 工具调用的成功结果。 */
export interface ToolSuccess {
  ok: true
  result: Rec
}

export type ToolResult = ToolSuccess | ToolFailure

/** 成功结果包装。 */
export function ok(result: Rec): ToolSuccess {
  return { ok: true, result }
}

/** 结构化失败包装；extra 附加字段（如 status / sources_failed）。 */
export function fail(code: string, message: string, extra: Rec = {}): ToolFailure {
  return { ok: false, error: { code, message, ...extra } }
}
