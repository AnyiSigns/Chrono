// #3（L2）与 #21（L3）数据形状的解析与派生纯函数。

import { asString, isRecord } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** L3 存活条目（`memory.list` 的扁平结果）。 */
export interface LiveEntry {
  id: string
  text: string
  meta: Rec
  weight: number | undefined
  at: string
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

/** `memory.list` 的 `entries` 归一为存活条目（形态不合的项跳过）。 */
export function parseEntries(listed: Rec): LiveEntry[] {
  const raw = Array.isArray(listed['entries']) ? (listed['entries'] as Json[]) : []
  const entries: LiveEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue
    const meta = isRecord(item['meta']) ? (item['meta'] as Rec) : {}
    entries.push({
      id: item['id'] as string,
      text: typeof item['text'] === 'string' ? (item['text'] as string) : '',
      meta,
      weight: typeof item['weight'] === 'number' ? (item['weight'] as number) : undefined,
      at: asString(meta['at']) ?? '',
    })
  }
  return entries
}

/** 确定性业务 id（非内核哈希）：FNV-1a 32 位十六进制；同 workspace + at + 文本 ⇒ 同 id。 */
export function deriveEntryId(workspace: string, text: string, at: string): string {
  const seed = `${at}\u0000${workspace}\u0000${text}`
  let hash = 0x811c9dc5
  for (const ch of seed) {
    hash ^= ch.codePointAt(0) as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `m-${hash.toString(16).padStart(8, '0')}`
}
