// 服务内部共享类型与结构化错误（纯类型声明 + 错误类；不 import 宿主与内核）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 调用帧 env（宿主填写，机械）：本回合 run / 发起者 thread / 宿主固定时钟。 */
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

/** 反向调用结果：成功带值，失败带结构化码（失败作数据，不炸本轮）。 */
export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

/** 反向调用抽象：生产环境是 PortLink，单测注入假端口。 */
export interface PortCaller {
  call(port: string, method: string, args: Rec): Promise<PortOutcome>
}

/** 一次方法调用的产物：返回值 + 随计划上行事件。 */
export interface HandlerResult {
  value: Json
  events: ServiceEvent[]
}

export type Handler = (args: Json, env: CallEnv) => Promise<HandlerResult>

/** args 形态非法（非对象 / 缺必需字段）：结构化 bad_args，不崩进程、不产计划。 */
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

/** 图六类条目 + 阈值的归一模型（服务不读投影：全部来自 bag）。 */
export interface GraphModel {
  contracts: Rec[]
  nodes: Rec[]
  prompts: Rec
  graph: Rec
  thresholds: Rec
  refusalCodes: Rec[]
}

/** 解释器进程内状态（不落账；跨 run 续跑时序列化进游标）。 */
export interface RunState {
  iter: number
  steps: number
  slots: Rec
  shared: Rec
  extraMessages: Json[]
  messages: Json[]
  dispatchedTools: boolean
  questionPending: boolean
  verifyFailed: boolean
  lastCalls: Rec[]
}
