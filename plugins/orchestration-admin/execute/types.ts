// 业务失败（证据缺失 / 未校验 / 额度超限）：带结构化错误码。

import { ServiceError } from 'plugin-sdk'

export class ToolError extends ServiceError {
  constructor(code: string, message?: string) {
    super(code, message ?? code)
    this.name = 'ToolError'
  }
}
