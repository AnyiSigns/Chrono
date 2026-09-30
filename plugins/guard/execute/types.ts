// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 三值判定。 */
export type Verdict = 'allow' | 'escalate' | 'deny'

export { BadArgsError } from 'plugin-sdk'

/** 一个方法：args 进、值出。 */
export type Handler = (args: Json) => Json
