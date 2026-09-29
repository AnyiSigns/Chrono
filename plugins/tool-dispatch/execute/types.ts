// 服务内部共享类型与领域错误：JSON 面、args 形态错误与调用帧 env 由 plugin-sdk 提供；
// 本模块只做转发，供 dispatch / cache / config 同源取用。

export { BadArgsError, isRecord } from 'plugin-sdk'
export type { CallEnv, Handler, HandlerResult, Json, PortOutcome, Rec } from 'plugin-sdk'
