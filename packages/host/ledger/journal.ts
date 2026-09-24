// 账本：单条 append-only journal 文件的读写，以及全量重放 / 校验。
// 落盘保真：每条 entry 只做一次规范序列化后追加；重放读回的 args 与原值规范等价，
// 故 `argsHash` 必与原条目一致（内核在 replay/verify 中复核）。

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  truncateSync,
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
  /** journal 尾文件存在撕裂尾：持锁写方须先截断到 `journalValidBytes` 再 append。 */
  journalTruncated: boolean
  /** 有效前缀字节长度（截断目标）；无截断时等于文件大小（文件不存在为 0）。 */
  journalValidBytes: number
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

/** 容错读结果：有效前缀 + 是否截断 + 截断处字节偏移。 */
export interface JournalRead {
  entries: Entry[]
  /** 末行撕裂（无换行的半截 JSON）被丢弃：持锁写方须先截断到 `validBytes` 再 append。 */
  truncated: boolean
  /** 有效前缀的字节长度（含末条完整行的换行）；无截断时等于文件大小。 */
  validBytes: number
}

/**
 * 严格读：每行一条 entry 的规范 JSON；缺文件视为空账。
 * 任何非空行解析失败（含末行）都抛——用于 verify / replay / 冷段，完整性判定不得静默丢条目。
 */
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

/**
 * 容错读：追加是「整段一次写」，崩溃只可能留下**最后一条**非空行的半截（无换行结尾）。
 * 末段无换行且解析失败视为撕裂尾丢弃，并报告有效前缀字节数供写方截断；
 * 带换行的行解析失败仍是真损坏（含末行），中间行同理，一律抛。用于启动 / append 路径。
 */
export function readJournalTolerant(file: string): JournalRead {
  if (!existsSync(file)) return { entries: [], truncated: false, validBytes: 0 }
  const bytes = readFileSync(file)
  const entries: Entry[] = []
  let validBytes = 0
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const lineEnd = newline === -1 ? bytes.length : newline + 1
    if (newline === -1) {
      // 末段无换行：空段视为正常收尾；非空且解析失败即撕裂尾
      if (start < bytes.length) {
        const line = bytes.subarray(start, bytes.length).toString('utf8')
        try {
          entries.push(JSON.parse(line) as Entry)
          validBytes = bytes.length
        } catch {
          return { entries, truncated: true, validBytes }
        }
      }
      break
    }
    const line = bytes.subarray(start, newline).toString('utf8')
    if (line.length > 0) entries.push(JSON.parse(line) as Entry)
    validBytes = lineEnd
    start = lineEnd
  }
  return { entries, truncated: false, validBytes }
}

/**
 * 持锁写方在 append 前调用：容错读尾文件，检测到撕裂尾即截断到有效前缀。
 * 返回容错读结果（有效条目已排除撕裂尾）供调用方复用，避免重复读。
 */
export function repairJournalTail(file: string): JournalRead {
  const read = readJournalTolerant(file)
  if (read.truncated) truncateSync(file, read.validBytes)
  return read
}

/**
 * 追加 entries 并 fsync；空数组不产生任何落盘。
 * 追加前校验文件以 `\n` 结尾（非空时）：否则上一条是撕裂尾，直接追加会把新 entry 粘在残行上
 * 而被后续容错读当末行丢弃、终致 journal 永久损坏。调用方须先 `repairJournalTail` 截断。
 */
export function appendJournal(file: string, entries: Entry[]): void {
  if (entries.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  assertJournalAppendable(file)
  const payload = entries.map((e) => canonicalJson(e as unknown as Json)).join('\n') + '\n'
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 追加前守卫：非空文件末字节必须是换行，否则抛 `journal_torn_tail`（fail-closed，不粘行）。 */
function assertJournalAppendable(file: string): void {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    if (tail[0] !== 0x0a) throw new Error('journal_torn_tail')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 已关闭
      }
    }
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
 * 尾文件按容错读：撕裂尾被排除并回报在 `journalTruncated` / `journalValidBytes`，交持锁写方截断。
 * @param file journal 文件
 * @param baseFile 基础世界文件；缺省 = 不启用基础世界（测试 / 纯日志场景）
 * @param coldDir 冷段目录；缺省 = journal 同级的 `cold/`
 */
export function loadAnchor(file: string, baseFile?: string, coldDir?: string): Anchor {
  const cold = coldDir ?? join(dirname(file), 'cold')
  const base = baseFile === undefined ? null : readBase(baseFile)
  const tail = readJournalTolerant(file)
  if (base !== null && alignedWithBase(tail.entries, base.snapshot)) {
    const world = replay(tail.entries, base.world)
    const head =
      tail.entries.length > 0
        ? headOf(tail.entries)
        : { seq: base.snapshot.seq, hash: base.snapshot.hash }
    return {
      world,
      head,
      entries: tail.entries,
      baseSeq: base.snapshot.seq,
      baseAudits: base.audits,
      journalTruncated: tail.truncated,
      journalValidBytes: tail.validBytes,
    }
  }
  const entries = dedupeBySeq([...readColdEntries(cold), ...tail.entries])
  return {
    world: replay(entries, EMPTY_WORLD),
    head: headOf(entries),
    entries,
    baseSeq: -1,
    baseAudits: [],
    journalTruncated: tail.truncated,
    journalValidBytes: tail.validBytes,
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
