// 服务协议的类型面：调用帧 env、方法处理器、反向调用通道与错误分类。
// 纯类型与两个错误类；零内核零宿主依赖。

import type { Json, Rec } from './json.ts'

/**
 * 调用帧的 `env`（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟 / 发出者身份。
 * 服务发事件载荷、判 TTL 一律用它，不得自取时间。
 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
  /** 发出者身份（宿主解析填写）；缺省 null。 */
  emitter: string | null
}

/** 服务主动上行的事件（宿主只透传，不落账、不推进）。 */
export interface ServiceEvent {
  topic: string
  payload: Json
}

/** 一次方法调用的产物：返回给调用方的值 + 随结果发出的乐观事件。 */
export interface HandlerResult {
  value: Json
  events: ServiceEvent[]
}

/** 一个方法：args 与 env 进、结果出；失败抛 `BadArgsError` 或 `ServiceError` 子类。 */
export type Handler = (args: Json, env: CallEnv) => HandlerResult | Promise<HandlerResult>

/** 反向调用结果：成功带值，失败带稳定码（作数据，不抛）。 */
export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

/** 反向调用通道（服务 → 宿主，按发出者 `pins` 路由）。 */
export interface PortCaller {
  call(port: string, method: string, args: Rec): Promise<PortOutcome>
}

/** 领域错误基类：带固定码，派发器映射成协议 error 帧的 `code`。 */
export class ServiceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

/** args 形态非法：结构化 bad_args，不崩进程、不产计划。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}
