// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。
// JSON 面、args 形态错误、调用帧 env 由 plugin-sdk 提供；Handler 归本插件（返回普通值 / 计划）。

export { BadArgsError, isRecord } from 'plugin-sdk'
export type { CallEnv, Json, Rec } from 'plugin-sdk'

/** 一次方法调用的产物：返回给调用方的值（计划或数据）。 */
export type Handler = (args: Json, env: import('plugin-sdk').CallEnv) => Promise<Json> | Json
