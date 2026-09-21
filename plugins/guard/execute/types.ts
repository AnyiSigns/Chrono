// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 三值判定。 */
export type Verdict = 'allow' | 'escalate' | 'deny'

/** 逐 call 判定：理由码取自固定词表，机械可测。 */
export interface Decision {
  index: number
  port: string
  tool: string
  verdict: Verdict
  reason: string
  rule?: string
}

export interface JudgeSummary {
  allow: number
  escalate: number
  deny: number
}

export interface JudgeResult {
  decisions: Decision[]
  summary: JudgeSummary
}

/** args（bag）形态非法：结构化 bad_args，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 一个方法：args 进、值出。 */
export type Handler = (args: Json) => Json
