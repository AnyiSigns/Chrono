// 日志出口：统一 `[mcp] ` 前缀，日志只走 stderr。
import { makeLogger } from 'plugin-sdk'

export const log = makeLogger('mcp')
