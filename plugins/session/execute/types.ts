// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

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

/** 一次方法调用的产物：返回给调用方的值 + 随计划一起发的乐观事件。 */
export interface HandlerResult {
  value: Json
  events: ServiceEvent[]
}

export type Handler = (args: Json, env: CallEnv) => HandlerResult | Promise<HandlerResult>

/** 反向调用结果：成功带值，失败带稳定码（作数据，不抛）。 */
export type PortOutcome =
  | { ok: true; value: Json }
  | { ok: false; code: string; message: string }

/** 反向调用通道（服务 → 宿主，按发出者 `pins` 路由）。 */
export interface PortCaller {
  call(port: string, method: string, args: Rec): Promise<PortOutcome>
}

/** args 形态非法（非对象 / 缺必需字段）：结构化 bad_args，不崩进程、不产计划。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}
