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
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  canonicalJson,
  pos,
  replay,
  verify,
  worldRev,
} from '../../kernel/index.ts'
import type { Entry, Hash, Head, Json, World } from '../../kernel/index.ts'

export interface Anchor {
  world: World
  head: Head
  entries: Entry[]
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

/** 全量取用：从空世界重放全部 entry，得到当前世界与链头。 */
export function loadAnchor(file: string): Anchor {
  const entries = readJournal(file)
  return { world: replay(entries, EMPTY_WORLD), head: headOf(entries), entries }
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
