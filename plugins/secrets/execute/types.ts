// 密钥域错误：带固定码，由 SDK 派发器映射成协议 error 帧的 code；消息不含值、不含文件内容。

import { ServiceError } from 'plugin-sdk'

/** resolve / list 的结构化失败码（与契约口径一致）。 */
export type SecretErrorCode = 'secret_missing' | 'secret_unreadable' | 'bad_auth_ref'

/** 领域错误：带固定码，由 SDK 派发器映射成协议 error 帧。 */
export class SecretError extends ServiceError {
  readonly code: SecretErrorCode

  constructor(code: SecretErrorCode, message: string) {
    super(code, message)
    this.name = 'SecretError'
    this.code = code
  }
}
