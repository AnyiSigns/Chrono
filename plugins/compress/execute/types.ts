// 服务内部共享类型与结构化错误。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 结构化摘要形状（与 `summarize` 提供方同口径；跨身份不 import，消费方保留本地类型）。 */
export interface Summary {
  goal: string
  decisions: string[]
  facts: string[]
  open_questions: string[]
  files: string[]
  next_steps: string[]
}

/** 某列表字段的去重结果（由 `dedup` 提供方算得）。 */
export interface DedupOutcome {
  accepted: string[]
  dedup: 'vector' | 'text'
}

/** 调用帧 env（宿主填写，机械）：本回合 id / 发起者 thread / 固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

export { BadArgsError } from 'plugin-sdk'

/** 反向调用后端失败：带结构化码，调用方据此降级或作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 一个方法：args 进、值出（异步：semantic 模式经反向调用调模型）。 */
export type Handler = (args: Json, env: CallEnv) => Promise<Json>
