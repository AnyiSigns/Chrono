// compact 分片落盘 + 启动按需加载验收（宿主侧）：
// - compact 后 base.json 只含小索引（无 world），def body 落分片目录；
// - loadAnchor 只读尾段，世界与全链重放逐字节一致（worldRev 相等）；
// - 启动加载不触发全量分片读（loads === 0），只有真正取 body 才按需读；
// - 续写尾段后仍不触发基础 def 的读盘；
// - 全链 verify 仍过；compact 往返幂等。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EMPTY_HEAD, commit, worldRev } from '../../kernel/index.ts'
import type { Entry, Hash, Head, World } from '../../kernel/index.ts'
import {
  appendJournal,
  loadAnchor,
  readAllEntries,
  readBase,
  replayFull,
  verifyFull,
} from '../ledger/index.ts'
import { runCompact } from '../offline.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

describe('compact 分片 + 启动按需加载', () => {
  let root: string
  beforeEach(() => {
    root = createTempRoot()
  })
  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  const journalFile = (): string => join(root, 'state', 'world', 'journal.jsonl')
  const baseFile = (): string => join(root, 'state', 'world', 'base.json')
  const coldDir = (): string => join(root, 'state', 'world', 'cold')

  /** 直写 N 条 put（模拟历史链）。 */
  function writeEntries(count: number): void {
    const world = { defs: {}, ids: {} } as World
    let head: Head = { ...EMPTY_HEAD }
    const entries: Entry[] = []
    for (let i = 0; i < count; i++) {
      const outcome = commit(
        head,
        world,
        {
          id: `bench-${i}`,
          op: 'put',
          target: { expect_pos: head.hash },
          args: { body: { i, pad: 'x'.repeat(64) } },
          by: 'bench',
        },
        1000 + i,
      )
      if (!outcome.verdict.ok || outcome.entry === null) throw new Error('commit failed')
      head = { seq: outcome.entry.seq, hash: outcome.hash as Hash }
      entries.push(outcome.entry)
    }
    appendJournal(journalFile(), entries)
  }

  /** 从当前锚点续写 N 条 put。 */
  function appendEntries(count: number): void {
    const anchor = loadAnchor(journalFile(), baseFile())
    let head = anchor.head
    const world = anchor.world
    const entries: Entry[] = []
    for (let i = 0; i < count; i++) {
      const outcome = commit(
        head,
        world,
        {
          id: `tail-${i}`,
          op: 'put',
          target: { expect_pos: head.hash },
          args: { body: { tail: i } },
          by: 'bench',
        },
        2000 + i,
      )
      if (!outcome.verdict.ok || outcome.entry === null) throw new Error('commit failed')
      head = { seq: outcome.entry.seq, hash: outcome.hash as Hash }
      entries.push(outcome.entry)
    }
    appendJournal(journalFile(), entries)
  }

  it('compact 写 v2 分片索引：base.json 无 world，分片目录存在；loadAnchor 与全链一致', () => {
    writeEntries(8)
    runCompact(root)

    const index = JSON.parse(readFileSync(baseFile(), 'utf8')) as {
      v: number
      defs: string[]
      defsDir: string
      world?: unknown
    }
    expect(index.v).toBe(2)
    expect(index.world).toBeUndefined()
    expect(index.defs).toHaveLength(8)
    expect(existsSync(join(dirname(baseFile()), index.defsDir))).toBe(true)

    const full = replayFull(readAllEntries(journalFile(), coldDir()))
    const tail = loadAnchor(journalFile(), baseFile())
    expect(tail.baseSeq).toBe(8)
    expect(worldRev(tail.world)).toBe(worldRev(full))
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
  })

  it('启动按需：读索引与重放尾段零分片读；取 body 才读；续写尾段仍零基础读', () => {
    writeEntries(16)
    runCompact(root)

    // 读索引 + 重放「快照」尾段：不算世界摘要、不取 body，零分片读
    const base = readBase(baseFile())!
    expect(base.store!.stats.loads).toBe(0)
    const anchor = loadAnchor(journalFile(), baseFile())
    expect(worldRev(anchor.world)).toBe(
      worldRev(replayFull(readAllEntries(journalFile(), coldDir()))),
    )

    // 续写 3 条 put 后重载：尾段重放只做判存在（清单）与新增覆盖层，不读基础分片
    appendEntries(3)
    const reloaded = loadAnchor(journalFile(), baseFile())
    expect(reloaded.entries).toHaveLength(4) // snapshot + 3
    const reread = readBase(baseFile())!
    const anchor2 = loadAnchor(journalFile(), baseFile())
    expect(worldRev(anchor2.world)).toBe(
      worldRev(replayFull(readAllEntries(journalFile(), coldDir()))),
    )
    // 两次读索引都零分片读；世界摘要只吃键
    expect(reread.store!.stats.loads).toBe(0)

    // 取一个基础 def 的 body 才触发按需读（用同一次 readBase 的 store 观察）
    const someHash = JSON.parse(readFileSync(baseFile(), 'utf8')).defs[0] as Hash
    expect(reread.world.defs[someHash]).toBeDefined()
    expect(reread.store!.stats.loads).toBeGreaterThan(0)
  })

  it('compact 往返幂等：二次压缩只归档当前 journal，世界摘要仍一致', () => {
    writeEntries(5)
    runCompact(root)
    appendEntries(2)
    const second = runCompact(root)
    expect(second.moved).toBe(3)
    const all = readAllEntries(journalFile(), coldDir())
    for (let i = 1; i < all.length; i++) expect(all[i].seq).toBeGreaterThan(all[i - 1].seq)
    expect(verifyFull(all).ok).toBe(true)
    const tail = loadAnchor(journalFile(), baseFile())
    expect(worldRev(tail.world)).toBe(worldRev(replayFull(all)))
  })
})
