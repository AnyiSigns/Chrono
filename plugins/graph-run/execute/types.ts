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

export type { PortCaller, PortOutcome } from 'plugin-sdk'

/** 一次方法调用的产物：返回值 + 随计划上行事件。 */
export interface HandlerResult {
  value: Json
  events: ServiceEvent[]
}

export type Handler = (args: Json, env: CallEnv) => Promise<HandlerResult>

export { BadArgsError, ServiceError } from 'plugin-sdk'

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
  /** 近段签名窗口（末尾最新）：无进展空转检测（动作 + 观察 + 状态）。跨段经段标记 / 游标重建。 */
  loopSignatures: string[]
  /** 本轮空转是否已注入过 nudge（升级阶梯：先提示、再收口）。 */
  loopNudged: boolean
  /** 待注入下一次组装的 nudge 文本（一次性）；无则 null。 */
  loopNudge: string | null
  lastCalls: Rec[]
  /**
   * 本回合已落盘的展示段累计基线（工具卡按 `call_id` 合并）：步 `assistant.parts` 只写其增量。
   * 不进游标（派生物，续跑时由 `committedFromSteps` 从步日志重导），避免游标背展示数据。
   */
  committedParts: Json[]
}
