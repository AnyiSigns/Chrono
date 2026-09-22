// G3 def 大小实测：256KB inline 附件（base64）/ 文本上限的可行性——
// 量出 H / commit / 落盘行字节 / 全量重放的现实成本，喂给 G4（资产面）与 #1（input）定稿。
// 断言取宽松上限（防病态回归）；精确数值随测试输出记录。

import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { H, commit, canonicalJson } from '../../kernel/index.ts'
import type { Entry, Hash, Head, Json, World } from '../../kernel/index.ts'
import { EMPTY_HEAD, EMPTY_WORLD } from '../../kernel/index.ts'
import { appendJournal, loadAnchor } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

const KB = 1024

interface PutResult {
  entry: Entry
  head: Head
  world: World
}

/** 以宿主审计同款直写（commit）落一条 put，返回 entry / 新链头。 */
function commitPut(world: World, head: Head, id: string, body: Json): PutResult {
  const outcome = commit(
    head,
    world,
    {
      id,
      op: 'put',
      target: { expect_pos: head.hash },
      args: { body },
      by: 'bench',
    },
    Date.now(),
  )
  if (!outcome.verdict.ok || outcome.entry === null) {
    throw new Error(`commit rejected: ${outcome.verdict.reasons.join(',')}`)
  }
  return {
    entry: outcome.entry,
    head: { seq: outcome.entry.seq, hash: outcome.hash as Hash },
    world,
  }
}

function timeIt(fn: (i: number) => void, rounds: number): { meanMs: number; maxMs: number } {
  let total = 0
  let max = 0
  for (let i = 0; i < rounds; i++) {
    const begin = performance.now()
    fn(i)
    const ms = performance.now() - begin
    total += ms
    if (ms > max) max = ms
  }
  return { meanMs: total / rounds, maxMs: max }
}

/** 同形 def 加一个序号：commit 按 Def 去重（dup），实测须每轮不同。 */
function withSeq(def: Json, i: number): Json {
  const body = (def as { body: { [k: string]: Json } }).body
  return { body: { ...body, seq: i } }
}

describe('G3 def 大小实测（256KB inline / 文本 / 落盘 / 重放）', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTempRoot(root)
  })

  it('base64 膨胀系数与 256KB 附件 def 的 H / commit 成本', () => {
    const bytes = randomBytes(256 * KB)
    const base64 = bytes.toString('base64')
    // base64 膨胀 = ceil(n/3)*4（256KB=3×87381+1 → 2 字节 padding）
    expect(base64.length).toBe(Math.ceil((256 * KB) / 3) * 4)

    const def: Json = {
      body: {
        kind: 'attachment',
        mime: 'application/octet-stream',
        size: 256 * KB,
        inline: base64,
      },
    }
    const hashTiming = timeIt(() => void H(def), 10)
    const world = { ...EMPTY_WORLD, defs: {}, ids: {} } as World
    let head: Head = { ...EMPTY_HEAD }
    const commitTiming = timeIt((i) => {
      const result = commitPut(world, head, `bench-${i}`, withSeq(def, i))
      head = result.head
    }, 10)
    const line = canonicalJson(def as Json).length
    console.log(
      `[G3] 256KB 附件：base64=${base64.length}B defJSON=${line}B H mean=${hashTiming.meanMs.toFixed(1)}ms ` +
        `commit mean=${commitTiming.meanMs.toFixed(1)}ms max=${commitTiming.maxMs.toFixed(1)}ms`,
    )
    expect(hashTiming.meanMs).toBeLessThan(500)
    expect(commitTiming.meanMs).toBeLessThan(1000)
  })

  it('256KB inline 条目落盘 / 全量重放：32 条量级（journal 体积 = 世界体积）', () => {
    const root = createTempRoot()
    roots.push(root)
    const file = join(root, 'state', 'world', 'journal.jsonl')
    const base64 = randomBytes(256 * KB).toString('base64')
    const world = { ...EMPTY_WORLD, defs: {}, ids: {} } as World
    let head: Head = { ...EMPTY_HEAD }
    const entries: Entry[] = []
    for (let i = 0; i < 32; i++) {
      const result = commitPut(world, head, `bench-${i}`, {
        kind: 'attachment',
        seq: i,
        size: 256 * KB,
        inline: base64,
      })
      head = result.head
      entries.push(result.entry)
    }
    const bytes = entries.reduce(
      (sum, entry) => sum + canonicalJson(entry as unknown as Json).length + 1,
      0,
    )
    const appendBegin = performance.now()
    appendJournal(file, entries)
    const appendMs = performance.now() - appendBegin
    const readBegin = performance.now()
    const anchor = loadAnchor(file)
    const readMs = performance.now() - readBegin
    console.log(
      `[G3] 32×256KB 内联条目：journal≈${(bytes / (1024 * 1024)).toFixed(1)}MiB ` +
        `append=${appendMs.toFixed(0)}ms 全量重放=${readMs.toFixed(0)}ms ` +
        `单条均值=${(readMs / 32).toFixed(1)}ms`,
    )
    expect(anchor.head.seq).toBe(31)
    expect(anchor.world.defs[entries[0] ? (H(entries[0].args as Json) as Hash) : '']).toBeDefined()
    // 宽松上限：32 条 8MiB 量级重放不应超过 10s（真实值见输出）
    expect(readMs).toBeLessThan(10_000)
  })

  it('文本 def：64KB / 256KB 字符串的 H / commit 成本', () => {
    const world = { ...EMPTY_WORLD, defs: {}, ids: {} } as World
    for (const size of [64 * KB, 256 * KB]) {
      const text = '中'.repeat(size / 3) // UTF-8 中文 3 字节
      const def: Json = { body: { kind: 'chat.message', text } }
      const hashTiming = timeIt(() => void H(def), 10)
      let head: Head = { ...EMPTY_HEAD }
      const commitTiming = timeIt((i) => {
        const result = commitPut(world, head, `text-${size}-${i}`, withSeq(def, i))
        head = result.head
      }, 10)
      console.log(
        `[G3] 文本 ${(size / KB).toFixed(0)}KB：H mean=${hashTiming.meanMs.toFixed(1)}ms ` +
          `commit mean=${commitTiming.meanMs.toFixed(1)}ms`,
      )
      expect(hashTiming.meanMs).toBeLessThan(500)
      expect(commitTiming.meanMs).toBeLessThan(1000)
    }
  })
})
