// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** resolve 的结构化失败码（与 DESIGN 口径一致）。 */
export type SecretErrorCode = 'secret_missing' | 'secret_unreadable' | 'bad_auth_ref'

/** 领域错误：带固定码，由 main 转成协议 error 帧；消息不含值、不含文件内容。 */
export class SecretError extends Error {
  readonly code: SecretErrorCode

  constructor(code: SecretErrorCode, message: string) {
    super(message)
    this.name = 'SecretError'
    this.code = code
  }
}

/** args 形态非法：结构化 bad_args，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 一个方法：args 进、值出；失败抛 SecretError / BadArgsError。 */
export type Handler = (args: Json) => Json
