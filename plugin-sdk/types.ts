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

/**
 * 一次调用的身份上下文：发起 `call` 帧的 id、逻辑端口与方法，外加调用帧 `env`。
 * 处理器据 `callId` 让反向调用回带发起帧，宿主据此把反向调用归属到正确回合（并发在途不串台）。
 */
export interface CallContext {
  /** 发起 `call` 帧 id（宿主填）；回带进反向 `port.call` 的 `call_id` 字段。 */
  callId: string
  /** 本次调用的逻辑端口（能力类名）。 */
  port: string
  /** 本次调用的方法名。 */
  method: string
  /** 与处理器第二个参数同值的调用帧 `env`。 */
  env: CallEnv
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

/**
 * 一个方法：args、env 与调用身份上下文进、结果出；失败抛 `BadArgsError` 或 `ServiceError` 子类。
 * 第三个参数是后加的，只关心 `args` / `env` 的处理器可忽略它（旧签名仍兼容）。
 */
export type Handler = (
  args: Json,
  env: CallEnv,
  call: CallContext,
) => HandlerResult | Promise<HandlerResult>

/** 反向调用结果：成功带值，失败带稳定码（作数据，不抛）。 */
export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

/** 单次反向调用的覆盖项：回带发起帧 id、等待上限、按成员定位的 `many` 目标。 */
export interface PortCallOptions {
  /** 发起 `call` 帧 id；宿主据此把本次反向调用归属到正确回合（并发在途不串台）。 */
  callId?: string | null
  /** 本次等待上限；缺省用通道构造时的 `timeoutMs`。 */
  timeoutMs?: number
  /**
   * 按成员定位的 `many` 目标：反向调用 `port.call` 携带目标提供方身份名（配合扩展类 `port`），
   * 宿主校验「该类在发出者 `needs` 且 `mode:"many"`」且「目标 ∈ 索引(类)」后按该成员端点调用。
   * 缺省 = 单值语义（`one`-needs / 自能力）。
   */
  provider?: string
}

/** 反向调用通道（服务 → 宿主，按发出者 `one`-needs / 成员定位的 `many` 路由）。 */
export interface PortCaller {
  call(port: string, method: string, args: Rec, options?: PortCallOptions): Promise<PortOutcome>
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
