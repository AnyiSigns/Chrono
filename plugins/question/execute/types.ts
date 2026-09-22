// 服务内部共享类型（纯类型声明与结构化错误；不 import 宿主与内核）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Rec = { [key: string]: Json }

/** 调用帧的 `env`（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

/** 服务主动上行的事件（宿主只透传，不落账、不推进）。 */
export interface ServiceEvent {
  topic: string
  payload: Json
}

/** 一次方法调用的产物：返回值 + 可选的随计划上行事件。 */
export interface HandlerResult {
  value: Json
  events?: ServiceEvent[]
}

export type Handler = (args: Json, env: CallEnv) => HandlerResult | Promise<HandlerResult>

/** args 形态非法（非对象 / 缺必需字段）：结构化 bad_args，不崩进程、不产计划。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 业务失败（未知工具 / 越界声明 / 找不到 item）：带结构化错误码，作数据回 invoke 结果。 */
export class ToolError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'ToolError'
    this.code = code
  }
}
