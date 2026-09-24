// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 调用帧的 `env`（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

export type Rec = { [key: string]: Json }

/** 一次方法调用的产物：返回给调用方的值（无写通道、无事件）。 */
export interface HandlerResult {
  value: Json
}

export type Handler = (args: Json, env: CallEnv) => HandlerResult | Promise<HandlerResult>

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
