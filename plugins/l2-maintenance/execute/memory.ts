// #3（L1/L2）数据形状的解析纯函数：会话 / 工作区容器与 ISO 时间。

import { asString, isRecord } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

export function sessionsOf(memory: Rec): Rec {
  return isRecord(memory['sessions']) ? (memory['sessions'] as Rec) : {}
}

export function workspacesOf(memory: Rec): Rec {
  return isRecord(memory['workspaces']) ? (memory['workspaces'] as Rec) : {}
}

export function recordAt(container: Rec, key: string): Rec {
  const value = container[key]
  return isRecord(value) ? value : {}
}

export function stringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** ISO 时间串 → 毫秒；非法 / 缺失回 null。 */
export function parseIso(value: Json | undefined): number | null {
  const text = asString(value)
  if (text === null) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}
