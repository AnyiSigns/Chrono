// 世界数据形状（body / 条目）的解析与派生纯函数。
// 服务不读投影：body + refs 由调用方入口 term 读出随 args 传入；本文件只做形状归一与链式遍历。

import { asString, asStringList, isRecord, isoAt, numberField } from './plan.ts'
import { BadArgsError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** `meta.source` 词表（写入路径：manual = agent 显式保存，consolidate = 记忆维护固化）。 */
const SOURCES = new Set(['session', 'skill', 'manual', 'consolidate'])

/** 条目 def：各自成 def、内容寻址；chunks 只存偏移。 */
export interface Entry {
  id: string
  text: string
  meta: Rec
  weight?: number
  chunks: Array<{ index: number; start: number; end: number }>
  prev: { def: string } | null
}

/** 链式条目（hash = refs 键）。 */
export interface LinkedEntry {
  hash: string
  entry: Rec
}

/** 传入的 body 必须是对象；deleted / pinned 缺省按空表。 */
export function asBody(value: Json | undefined): Rec {
  if (!isRecord(value)) throw new BadArgsError('body must be an object')
  return value
}

/** 传入的 refs 必须是对象（hash → def body）。 */
export function asRefs(value: Json | undefined): Rec {
  if (!isRecord(value)) throw new BadArgsError('refs must be an object')
  return value
}

/** body.count（缺省 0）。 */
export function countOf(body: Rec): number {
  const count = body['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
}

/** body.tail.def；无链尾回 null。 */
export function tailHashOf(body: Rec): string | null {
  const tail = body['tail']
  return isRecord(tail) ? asString(tail['def']) : null
}

/** 条目 id；缺失回 null。 */
export function entryIdOf(entry: Rec): string | null {
  return asString(entry['id'])
}

/**
 * 按链式 tail → prev 遍历条目，返回**从新到旧**的确定序列；
 * 环 / 断链（hash 不在 refs）即停，避免异常数据挂死。
 */
export function linkedEntries(body: Rec, refs: Rec): LinkedEntry[] {
  const out: LinkedEntry[] = []
  const seen = new Set<string>()
  let cursor = tailHashOf(body)
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const entry = refs[cursor]
    if (!isRecord(entry)) break
    out.push({ hash: cursor, entry })
    const prev = entry['prev']
    cursor = isRecord(prev) ? asString(prev['def']) : null
  }
  return out
}

/** 条目是否被 `body.deleted` 逻辑删除（键 = 条目 id）。 */
export function isDeleted(body: Rec, entry: Rec): boolean {
  const id = entryIdOf(entry)
  if (id === null) return false
  const deleted = body['deleted']
  return isRecord(deleted) && Object.hasOwn(deleted, id)
}

/**
 * 存活条目 id → 链上 hash（跳过 `body.deleted`）。
 * 链序从新到旧，故重复 id 取**最新**一条；不在链上（未落账 / 已不可达）的条目自然缺席。
 */
export function liveIdToHash(body: Rec, refs: Rec): Map<string, string> {
  const map = new Map<string, string>()
  for (const { hash, entry } of linkedEntries(body, refs)) {
    const id = entryIdOf(entry)
    if (id === null || isDeleted(body, entry)) continue
    if (!map.has(id)) map.set(id, hash)
  }
  return map
}

/** 条目正文的码点切片（chunks 只存偏移，文本由 text 派生）。 */
export function sliceChunkText(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('')
}

/** 确定性业务 id（非内核哈希）：FNV-1a 32 位十六进制；同 at + 同文本 ⇒ 同 id。 */
export function deriveEntryId(text: string, at: string): string {
  const seed = `${at}\u0000${text}`
  let hash = 0x811c9dc5
  for (const ch of seed) {
    hash ^= ch.codePointAt(0) as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `m-${hash.toString(16).padStart(8, '0')}`
}

/** 归一 `meta`：at 由 bag 传入（缺省回落帧时钟），source 缺省 manual。 */
export function parseMeta(args: Rec, now: number): Rec {
  const raw = isRecord(args['meta']) ? (args['meta'] as Rec) : {}
  const source = asString(raw['source']) ?? 'manual'
  if (!SOURCES.has(source)) {
    throw new BadArgsError('meta.source must be session/skill/manual/consolidate')
  }
  const meta: Rec = {
    source,
    at: asString(raw['at']) ?? isoAt(now),
    tags: asStringList(raw['tags'], 'meta.tags'),
  }
  const workspace = asString(raw['workspace'])
  if (workspace !== null) meta['workspace'] = workspace
  const session = asString(raw['session'])
  if (session !== null) meta['session'] = session
  return meta
}

/** 可选 weight（0–1）；缺省不落键。 */
export function parseWeight(value: Json | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  return numberField(value, 'weight', 0, 0, 1)
}

/** 构造条目 def（chunks 去文本、只留偏移；prev 指旧链尾字面哈希）。 */
export function buildEntry(input: {
  id: string
  text: string
  meta: Rec
  weight?: number
  chunks: Array<{ index: number; start: number; end: number }>
  prev: string | null
}): Rec {
  const entry: Rec = {
    id: input.id,
    text: input.text,
    meta: input.meta,
    chunks: input.chunks.map((chunk) => ({ index: chunk.index, start: chunk.start, end: chunk.end })),
    prev: input.prev === null ? null : { def: input.prev },
  }
  if (input.weight !== undefined) entry['weight'] = input.weight
  return entry
}

/** 构造新 body：tail 指向同批条目 def（占位符）、count+1、保留 deleted / pinned、锚刷新为当前 schema。 */
export function buildBody(input: { body: Rec; entryIndex: number; anchor: { id: string; dim: number } }): Rec {
  return {
    tail: { def: { $n: input.entryIndex } },
    count: countOf(input.body) + 1,
    deleted: isRecord(input.body['deleted']) ? input.body['deleted'] : {},
    pinned: isRecord(input.body['pinned']) ? input.body['pinned'] : {},
    model: { id: input.anchor.id, dim: input.anchor.dim },
  }
}
