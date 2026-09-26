// 日志出口：统一 `[memory-consolidate] ` 前缀，日志只走 stderr。
import { makeLogger } from 'plugin-sdk'

export const log = makeLogger('memory-consolidate')
