// 服务内部共享类型（纯类型 + 少量基类；类型剥离安全）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 调用帧的 `env`（宿主填写，机械）：回合 / 线程 / 固定时钟。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

/** 结构化工具错误：code 取自固定词表，失败作数据回给调用方。 */
export class ToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/**
 * 错误码闭集（与 `schema/tool-browser.json` 的 `invoke_result.error.code` 一致）。
 * 任何对外失败码都必须落在此表内；资产面等外部码在边界处归一（见 invoke 的 assetError）。
 */
export const ERROR_CODES = [
  'session_not_found',
  'navigate_failed',
  'http_status',
  'element_not_found',
  'net_denied',
  'browser_unsupported',
  'binary_unsupported',
  'tool_timeout',
  'tool_failed',
  'unknown_tool',
  'bad_args',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** args / bag 形态非法：结构化 bad_args，不崩进程。 */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}
