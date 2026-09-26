// 服务内部共享类型（纯类型 + 少量基类；类型剥离安全）。
// JSON 面、args 形态错误、调用帧 env 由 plugin-sdk 提供；ToolError 与错误码词表归本插件。

export { BadArgsError } from 'plugin-sdk'
export type { CallEnv, Json, Rec } from 'plugin-sdk'

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
