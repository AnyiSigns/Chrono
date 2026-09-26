// 服务内部共享类型与领域错误：JSON 面、args 形态错误与调用帧 env 由 plugin-sdk 提供；
// 本模块只保留带结构化码的 ToolError（本插件出码或提供者原码透传）。

export { BadArgsError, isRecord } from 'plugin-sdk'
export type { CallEnv, Handler, HandlerResult, Json, Rec, ServiceEvent } from 'plugin-sdk'

import { ServiceError } from 'plugin-sdk'

/** 带结构化码的业务失败：本插件出码或提供者原码透传。 */
export class ToolError extends ServiceError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'ToolError'
  }
}
