// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Rec = { [key: string]: Json }

/** 调用帧的 `env`（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

export interface HandlerResult {
  value: Json
  events: { topic: string; payload: Json }[]
}

export type Handler = (args: Json, env: CallEnv) => Promise<HandlerResult>

export { BadArgsError } from 'plugin-sdk'
