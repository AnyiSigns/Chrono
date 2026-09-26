// 服务内部共享类型（纯类型声明，类型剥离安全；运行时不留痕）。
// JSON 面、args 形态错误、调用帧 env、处理器与结果类型由 plugin-sdk 提供。

export { BadArgsError, isRecord } from 'plugin-sdk'
export type { CallEnv, Handler, HandlerResult, Json, Rec, ServiceEvent } from 'plugin-sdk'
