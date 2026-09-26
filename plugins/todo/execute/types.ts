// 业务失败（超限 / 坏枚举 / 缺投影数据）：带结构化错误码。

import { ServiceError } from 'plugin-sdk'

export class ToolError extends ServiceError {
  constructor(code: string, message?: string) {
    super(code, message ?? code)
    this.name = 'ToolError'
  }
}
