// 服务内部共享类型（纯类型声明与结构化错误；不 import 宿主与内核）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Rec = { [key: string]: Json }

/** 调用帧的 `env`（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟 / 发出者身份。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
  /** 发出者身份：命名空间分目录的唯一依据，调用方无从伪造。 */
  emitter: string | null
}

/** 一次方法调用的产物：只有返回值（本服务无事件、无写计划）。 */
export interface HandlerResult {
  value: Json
}

export type Handler = (args: Json, env: CallEnv) => HandlerResult | Promise<HandlerResult>

/** args 形态非法（非对象 / 缺必需字段 / 自报命名空间）：结构化 bad_args，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 存储引擎的结构化失败：带错误码作数据回调用方，不抛未捕获错误。 */
export class StoreError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'StoreError'
    this.code = code
  }
}
