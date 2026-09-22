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

/** 反向调用后端失败：带结构化码，调用方据此降级或作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 一个方法：args 进、值出（异步：索引重建经反向调用调向量化服务）。 */
export type Handler = (args: Json, env: CallEnv) => Promise<Json>
