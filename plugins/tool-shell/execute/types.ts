// 服务内部共享类型与领域错误：JSON 面、args 形态错误由 plugin-sdk 提供；
// 本模块只保留带结构化码的 ToolError（sandbox / secrets 的失败码在此原样搬运，不吞、不改写）。

export { BadArgsError, isRecord } from 'plugin-sdk'
export type { Handler, HandlerResult, Json, Rec, ServiceEvent } from 'plugin-sdk'

import { ServiceError } from 'plugin-sdk'

/** 一次工具调用 / 反向调用的结构化失败。 */
export class ToolError extends ServiceError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'ToolError'
  }
}
