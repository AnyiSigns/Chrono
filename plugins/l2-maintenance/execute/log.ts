// 日志出口：统一 `[l2-maintenance] ` 前缀，日志只走 stderr。
import { makeLogger } from 'plugin-sdk'

export const log = makeLogger('l2-maintenance')
