// 服务内部共享类型与结构化错误（纯类型 + 一个错误类，类型剥离安全）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** args 形态非法：结构化 `bad_args`，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** 一个方法：args 进、值出。 */
export type Handler = (args: Json) => Json
