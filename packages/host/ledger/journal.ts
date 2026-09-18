// 账本：单条 append-only journal 文件的读写，以及全量重放 / 校验。
// 落盘保真：每条 entry 只做一次规范序列化后追加；重放读回的 args 与原值规范等价，
// 故 `argsHash` 必与原条目一致（内核在 replay/verify 中复核）。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  canonicalJson,
  entryHash,
  pos,
  replay,
  verify,
  worldRev,
} from '../../kernel/index.ts'
import type { Entry, Hash, Head, Json, World } from '../../kernel/index.ts'
import { writeFileAtomic } from './atomic.ts'
import { readBase } from './base.ts'
import type { BaseAuditRef } from './base.ts'

export interface Anchor {
  world: World
  head: Head
  /** 本次载入的 entry：无 base 时 = 全链；有 base 时 = 快照起的尾段（含快照 entry）。 */
  entries: Entry[]
  /** 基础世界文件对应的快照位置（无 base = -1）。 */
  baseSeq: number
  /** 基础世界文件携带的审计索引（body 由调用方从 `world.defs[hash]` 取回）。 */
  baseAudits: BaseAuditRef[]
}

export interface VerifyReport {
  ok: boolean
  error?: string
  head?: Head
  worldRev?: Hash
}

/** 链头：末条 entry 的 seq 与位置哈希；空日志即 EMPTY_HEAD。 */
export function headOf(entries: Entry[]): Head {
  if (entries.length === 0) return EMPTY_HEAD
  const last = entries[entries.length - 1]
  return { seq: last.seq, hash: pos(entries) as Hash }
}

/** 读入 journal：每行一条 entry 的规范 JSON；缺文件视为空账。 */
export function readJournal(file: string): Entry[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    entries.push(JSON.parse(line) as Entry)
  }
  return entries
}

/** 追加 entries 并 fsync；空数组不产生任何落盘。 */
export function appendJournal(file: string, entries: Entry[]): void {
  if (entries.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  const payload = entries.map((e) => canonicalJson(e as unknown as Json)).join('\n') + '\n'
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 段落的规范序列化（每行一条 entry）。 */
function journalText(entries: Entry[]): string {
  return entries.map((e) => canonicalJson(e as unknown as Json)).join('\n') + '\n'
}

/** 原子写整份 journal（压缩时重写尾段；temp + fsync + rename + 目录 fsync）。 */
export function writeJournalAtomic(file: string, entries: Entry[]): void {
  writeFileAtomic(file, journalText(entries))
}

const COLD_SEGMENT = /^seg-(\d+)-(\d+)\.jsonl$/

/** 冷段归档：前缀 entry 原子写入 `cold/seg-<first>-<last>.jsonl`；空数组不产生文件。 */
export function archiveColdSegment(coldDir: string, entries: Entry[]): string | null {
  if (entries.length === 0) return null
  const first = entries[0].seq
  const last = entries[entries.length - 1].seq
  // seq 直接进文件名：非安全整数一律拒（防被篡改 journal 造成路径穿越）
  if (!isSeq(first) || !isSeq(last)) throw new Error('bad_journal')
  writeFileAtomic(join(coldDir, `seg-${first}-${last}.jsonl`), journalText(entries))
  return `seg-${first}-${last}.jsonl`
}

function isSeq(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** 读全部冷段（按首 seq 升序拼接）；跨段按 seq 去重，容忍崩溃窗口产生的重叠。 */
export function readColdEntries(coldDir: string): Entry[] {
  if (!existsSync(coldDir)) return []
  const names = readdirSync(coldDir).filter((name) => COLD_SEGMENT.test(name))
  names.sort((a, b) => firstSeq(a) - firstSeq(b))
  const entries: Entry[] = []
  for (const name of names) entries.push(...readJournal(join(coldDir, name)))
  return dedupeBySeq(entries)
}

function firstSeq(name: string): number {
  const match = COLD_SEGMENT.exec(name)
  return match === null ? 0 : Number(match[1])
}

/** 全链 entry：冷段 + 当前 journal（离线 verify / replay 用）；按 seq 去重。 */
export function readAllEntries(journalFile: string, coldDir: string): Entry[] {
  return dedupeBySeq([...readColdEntries(coldDir), ...readJournal(journalFile)])
}

/** 按 seq 严格递增去重：重叠段/崩溃残留只保留先出现的一份。 */
function dedupeBySeq(entries: Entry[]): Entry[] {
  const out: Entry[] = []
  let last = -1
  for (const entry of entries) {
    if (typeof entry.seq !== 'number' || entry.seq <= last) continue
    last = entry.seq
    out.push(entry)
  }
  return out
}

/**
 * 取用世界（G6）：base 与 journal 尾段对齐时只读「快照起的尾段」并接在基础世界上重放；
 * base 缺失 / 与尾段不对齐（崩溃窗口）时回落**全链**（冷段 + 尾段，按 seq 去重）从空世界重放——
 * 基础世界文件是派生缓存，丢了不丢数据。base 形态损坏（`readBase` 抛 `bad_base`）仍 fail-closed。
 * @param file journal 文件
 * @param baseFile 基础世界文件；缺省 = 不启用基础世界（测试 / 纯日志场景）
 * @param coldDir 冷段目录；缺省 = journal 同级的 `cold/`
 */
export function loadAnchor(file: string, baseFile?: string, coldDir?: string): Anchor {
  const cold = coldDir ?? join(dirname(file), 'cold')
  const base = baseFile === undefined ? null : readBase(baseFile)
  const journal = readJournal(file)
  if (base !== null && alignedWithBase(journal, base.snapshot)) {
    const world = replay(journal, base.world)
    const head =
      journal.length > 0 ? headOf(journal) : { seq: base.snapshot.seq, hash: base.snapshot.hash }
    return { world, head, entries: journal, baseSeq: base.snapshot.seq, baseAudits: base.audits }
  }
  const entries = readAllEntries(file, cold)
  return {
    world: replay(entries, EMPTY_WORLD),
    head: headOf(entries),
    entries,
    baseSeq: -1,
    baseAudits: [],
  }
}

/** 尾段是否锚定在该快照位置：空尾段视为对齐；否则首条须恰为快照 entry。 */
function alignedWithBase(entries: Entry[], snapshot: { seq: number; hash: Hash }): boolean {
  if (entries.length === 0) return true
  const first = entries[0]
  return first.seq === snapshot.seq && entryHash(first) === snapshot.hash
}

/** 全量校验：链完整性 + 段末内容摘要。 */
export function verifyFull(entries: Entry[]): VerifyReport {
  const verdict = verify(entries, { world: EMPTY_WORLD, head: EMPTY_HEAD })
  if (!verdict.ok) return { ok: false, error: verdict.error }
  const world = replay(entries, EMPTY_WORLD)
  return { ok: true, head: headOf(entries), worldRev: worldRev(world) }
}

/** 全量重放：只重建世界，不校验链（校验走 verifyFull）。 */
export function replayFull(entries: Entry[]): World {
  return replay(entries, EMPTY_WORLD)
}
