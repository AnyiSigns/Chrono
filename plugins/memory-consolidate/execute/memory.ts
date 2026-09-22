// #3（L1/L2）与 #21（L3）数据形状的解析与派生纯函数。
// 服务不读投影：body / refs 由调用方入口 term 读出随 args 传入；本文件只做形状归一与链式遍历。

import { asString, isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** L3 存活条目（链序从新到旧，跳过 `body.deleted`，重复 id 取最新一条）。 */
export interface LiveEntry {
  hash: string
  id: string
  text: string
  meta: Rec
  weight: number | undefined
  at: string
}

/** 传入的 #3 body 缺失 / 非法时回落空记忆（空集不产生写）。 */
export function asShortMemory(value: Json | undefined): Rec {
  if (!isRecord(value)) return { version: 1, sessions: {}, workspaces: {} }
  return value
}

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

/** `body.tail.def`；无链尾回 null。 */
export function tailHashOf(body: Rec): string | null {
  const tail = body['tail']
  return isRecord(tail) ? asString(tail['def']) : null
}

export function countOf(body: Rec): number {
  const count = body['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
}

export function isDeleted(body: Rec, id: string): boolean {
  const deleted = body['deleted']
  return isRecord(deleted) && Object.hasOwn(deleted, id)
}

/**
 * 按链式 tail → prev 遍历 #21 条目，返回**从新到旧**的确定序列；
 * 跳过 `body.deleted`，重复 id 取最新；环 / 断链即停（避免异常数据挂死）。
 */
export function liveEntries(body: Rec, refs: Rec): LiveEntry[] {
  const out: LiveEntry[] = []
  const seenHash = new Set<string>()
  const seenId = new Set<string>()
  let cursor = tailHashOf(body)
  while (cursor !== null && !seenHash.has(cursor)) {
    seenHash.add(cursor)
    const entry = refs[cursor]
    if (!isRecord(entry)) break
    const id = asString(entry['id'])
    if (id !== null && !isDeleted(body, id) && !seenId.has(id)) {
      seenId.add(id)
      out.push({
        hash: cursor,
        id,
        text: typeof entry['text'] === 'string' ? (entry['text'] as string) : '',
        meta: isRecord(entry['meta']) ? (entry['meta'] as Rec) : {},
        weight: typeof entry['weight'] === 'number' ? (entry['weight'] as number) : undefined,
        at: asString((isRecord(entry['meta']) ? entry['meta'] : {})['at']) ?? '',
      })
    }
    const prev = entry['prev']
    cursor = isRecord(prev) ? asString(prev['def']) : null
  }
  return out
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
