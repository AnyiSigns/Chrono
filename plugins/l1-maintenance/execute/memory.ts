// #3（L1）数据形状的解析纯函数：会话容器与 ISO 时间。

import { asString, isRecord } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** L1 会话容器（`body.sessions`）；缺失 / 非法回落空。 */
export function sessionsOf(memory: Rec): Rec {
  return isRecord(memory['sessions']) ? (memory['sessions'] as Rec) : {}
}

/** ISO 时间串 → 毫秒；非法 / 缺失回 null。 */
export function parseIso(value: Json | undefined): number | null {
  const text = asString(value)
  if (text === null) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}
