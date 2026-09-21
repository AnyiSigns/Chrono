// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 调用帧注入的运行态：宿主填写，服务不取时间。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

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

/** args（bag）形态非法：结构化 bad_args，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 成功结果包装。 */
export function ok(result: Rec): ToolSuccess {
  return { ok: true, result }
}

/** 结构化失败包装；extra 附加字段（如 status / sources_failed）。 */
export function fail(code: string, message: string, extra: Rec = {}): ToolFailure {
  return { ok: false, error: { code, message, ...extra } }
}

/** 普通对象判定。 */
export function isRec(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
