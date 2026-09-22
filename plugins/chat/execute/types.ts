// chat 服务内部共享类型与结构化错误。
// 服务不读投影、不写链、不自取时钟：世界数据由入口 term 读出随 args 传入。

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

/** 反向调用后端失败：带结构化码，调用方据此兜底或作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 反向调用结果：成功带值，失败带结构化码（失败作数据，不炸本轮）。 */
export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

/** 反向调用抽象：生产环境是 PortLink，单测注入假端口。 */
export interface PortCaller {
  call(port: string, method: string, args: Rec): Promise<PortOutcome>
}

/** 一个方法：args 进、值出（异步：send 要反向调用下游服务）。 */
export type Handler = (args: Json, env: CallEnv) => Promise<Json> | Json
