// 业务失败（hidden_identity / validate_required / 宿主错误透传）：带结构化错误码。

import { ServiceError } from 'plugin-sdk'

export class ToolError extends ServiceError {
  constructor(code: string, message?: string) {
    super(code, message ?? code)
    this.name = 'ToolError'
  }
}
