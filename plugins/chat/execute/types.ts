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

export { BadArgsError, ServiceError } from 'plugin-sdk'

/** 反向调用后端失败：带结构化码，调用方据此兜底或作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

export type { PortCaller, PortOutcome } from 'plugin-sdk'

/** 一个方法：args 进、值出（异步：send 要反向调用下游服务）。 */
export type Handler = (args: Json, env: CallEnv) => Promise<Json> | Json
