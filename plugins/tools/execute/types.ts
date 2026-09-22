// 服务内部共享类型与结构化错误。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 调用帧 env（宿主填写，机械）：本回合 id / 发起者 thread / 固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

/** args 形态非法：结构化 `bad_args`，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 带结构化码的业务失败：本插件出码或提供者原码透传。 */
export class ToolError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** 服务上行事件（宿主只透传，不落账、不推进）。 */
export interface EventOut {
  topic: string
  payload: Json
}

/** 一个方法的返回值：值 + 可选上行事件。 */
export interface HandlerResult {
  value: Json
  events?: EventOut[]
}

export type Handler = (args: Json, env: CallEnv) => Promise<HandlerResult>

/** 普通对象判定。 */
export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
