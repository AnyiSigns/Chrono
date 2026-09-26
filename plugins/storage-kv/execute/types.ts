// 存储引擎的结构化失败：带错误码，由 SDK 派发器映射成协议 error 帧的 code。

import { ServiceError } from 'plugin-sdk'

/** 存储引擎的结构化失败：带错误码作数据回调用方，不抛未捕获错误。 */
export class StoreError extends ServiceError {
  constructor(code: string, message?: string) {
    super(code, message ?? code)
    this.name = 'StoreError'
  }
}
