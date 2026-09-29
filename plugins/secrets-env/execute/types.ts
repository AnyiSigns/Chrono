// 进程环境密钥域错误：带固定码，由 SDK 派发器映射成协议 error 帧的 code；消息不含值。

import { ServiceError } from 'plugin-sdk'

/** read 的结构化失败码（与契约口径一致）。 */
export type EnvSecretErrorCode = 'secret_missing' | 'bad_args'

/** 领域错误：带固定码，由 SDK 派发器映射成协议 error 帧。 */
export class EnvSecretError extends ServiceError {
  readonly code: EnvSecretErrorCode

  constructor(code: EnvSecretErrorCode, message: string) {
    super(code, message)
    this.name = 'EnvSecretError'
    this.code = code
  }
}
