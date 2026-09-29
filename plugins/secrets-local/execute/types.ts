// 本地密钥域错误：带固定码，由 SDK 派发器映射成协议 error 帧的 code；消息不含值、不含文件内容。

import { ServiceError } from 'plugin-sdk'

/** read / list 的结构化失败码（与契约口径一致）。 */
export type LocalSecretErrorCode = 'secret_missing' | 'secret_unreadable'

/** 领域错误：带固定码，由 SDK 派发器映射成协议 error 帧。 */
export class LocalSecretError extends ServiceError {
  readonly code: LocalSecretErrorCode

  constructor(code: LocalSecretErrorCode, message: string) {
    super(code, message)
    this.name = 'LocalSecretError'
    this.code = code
  }
}
