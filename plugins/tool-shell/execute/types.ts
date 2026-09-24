// 服务内部共享类型与结构化错误。
// 错误面统一 `{ok:false, error:{code, message}}`：sandbox / secrets 的失败码在此原样搬运（不吞、不改写）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Rec = { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一次工具调用 / 反向调用的结构化失败。 */
export class ToolError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** 一个方法：args 进、值出；callId 为正在处理的那条 call 帧 id（反向调用回带用）。 */
export type Handler = (args: Json, callId: string | null) => Promise<Json>
