// G6 启动重放（F9）验收：基础世界文件 + 尾段重放 + 冷段归档。
// - 压缩后 loadAnchor 只读「快照起的尾段」，世界与全量重放逐字节一致（worldRev 相等）；
// - 全链校验（冷段 + 尾段）仍过；
// - 宿主启动达阈值自动压缩；
// - 坏基础世界文件 fail-closed（bad_base）；
// - 启动成本口径：载入 entry 数 = 尾段长度（而非全链），耗时随输出记录。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_HEAD, commit, worldRev } from '../../kernel/index.ts'
import type { Entry, Hash, Head, World } from '../../kernel/index.ts'
import {
  appendJournal,
  loadAnchor,
  readAllEntries,
  readColdEntries,
  readJournal,
  replayFull,
  verifyFull,
} from '../ledger/index.ts'
import { runCompact } from '../offline.ts'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { connect } from '../../client/index.ts'

describe('G6 启动重放（基础世界 + 尾段 + 冷段）', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 兜底停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }
  function baseFile(): string {
    return join(root, 'state', 'world', 'base.json')
  }
  function coldDir(): string {
    return join(root, 'state', 'world', 'cold')
  }

  /** 直写 N 条 put（模拟历史链）；返回写入后的世界与链头。 */
  function writeEntries(count: number): { world: World; head: Head } {
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
          args: { body: { i } },
          by: 'bench',
        },
        1000 + i,
      )
      if (!outcome.verdict.ok || outcome.entry === null) throw new Error('commit failed')
      head = { seq: outcome.entry.seq, hash: outcome.hash as Hash }
      entries.push(outcome.entry)
    }
    appendJournal(journalFile(), entries)
    return { world, head }
  }

  /** 从当前（含 base）锚点续写 N 条 put。 */
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

  it('compact：基础世界落盘 + 前缀冷段 + 尾段只读；世界与全量重放一致；全链校验仍过', () => {
    writeEntries(6)
    const full = loadAnchor(journalFile())
    expect(full.entries).toHaveLength(6)

    const report = runCompact(root)
    expect(report.moved).toBe(6)
    expect(report.snapshot.seq).toBe(6)
    expect(existsSync(baseFile())).toBe(true)
    expect(readJournal(journalFile())).toHaveLength(1) // 尾段 = [snapshot]
    expect(readColdEntries(coldDir())).toHaveLength(6)

    const tail = loadAnchor(journalFile(), baseFile())
    expect(tail.baseSeq).toBe(6)
    expect(tail.entries).toHaveLength(1)
    expect(tail.head.seq).toBe(6)
    expect(worldRev(tail.world)).toBe(worldRev(full.world))
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
  })

  it('压缩后续写：loadAnchor 读「快照 + 新尾段」，世界与全链重放一致', () => {
    writeEntries(4)
    runCompact(root)
    appendEntries(2)
    const tail = loadAnchor(journalFile(), baseFile())
    expect(tail.entries).toHaveLength(3) // snapshot + 2
    expect(tail.baseSeq).toBe(4)
    expect(tail.head.seq).toBe(6)
    const all = readAllEntries(journalFile(), coldDir())
    expect(all).toHaveLength(7) // 冷 4 + 尾 3
    expect(worldRev(tail.world)).toBe(worldRev(replayFull(all)))
    expect(verifyFull(all).ok).toBe(true)
  })

  it('宿主启动达阈值自动压缩：base 落盘、链头推进到快照，随后写入续链且全链可校验', async () => {
    writeEntries(3)
    const handle = await startHost({ root, compactTailEntries: 2 })
    handles.push(handle)
    expect(existsSync(baseFile())).toBe(true)

    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const status = await client.status()
      expect(status.world_head.seq).toBe(3) // 3 条 + 快照 entry
      const result = await client.submit([
        {
          kind: 'write',
          request: {
            id: 'w-after-compact',
            op: 'put',
            target: { expect_pos: status.world_head.hash },
            args: { body: { ok: true } },
            by: 'client',
          },
        },
      ])
      expect(result.status).toBe('done')
      expect((await client.status()).world_head.seq).toBe(4)
    } finally {
      client.close()
    }
    await handle.stop()
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
    const tail = loadAnchor(journalFile(), baseFile())
    expect(tail.baseSeq).toBe(3)
    expect(tail.head.seq).toBe(4)
  })

  it('compact 幂等：连续两次压缩不产生重叠冷段，全链校验仍过', () => {
    writeEntries(5)
    runCompact(root)
    appendEntries(2)
    const second = runCompact(root)
    expect(second.moved).toBe(3) // 第二次只归档「当前 journal」= 上快照 + 2 条
    const all = readAllEntries(journalFile(), coldDir())
    // 全链仍严格递增、无重复
    for (let i = 1; i < all.length; i++) expect(all[i].seq).toBeGreaterThan(all[i - 1].seq)
    expect(verifyFull(all).ok).toBe(true)
    const tail = loadAnchor(journalFile(), baseFile())
    expect(worldRev(tail.world)).toBe(worldRev(replayFull(all)))
  })

  it('base.json 缺失 → 回落全链（冷段 + 尾段）重放，不砖化；宿主可再启动并重建 base', async () => {
    writeEntries(4)
    runCompact(root)
    appendEntries(1)
    const full = replayFull(readAllEntries(journalFile(), coldDir()))
    rmSync(baseFile()) // 派生缓存丢失（模拟被删 / 写失败）

    const anchor = loadAnchor(journalFile(), baseFile())
    expect(anchor.baseSeq).toBe(-1)
    expect(worldRev(anchor.world)).toBe(worldRev(full))
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)

    // 宿主能在无 base 的压缩根上启动（回落全链），并按阈值重建 base
    const handle = await startHost({ root, compactTailEntries: 1 })
    handles.push(handle)
    expect(existsSync(baseFile())).toBe(true)
    await handle.stop()
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
  })

  it('坏基础世界文件：形态坏 / world_rev 不符 fail-closed；快照位置不符回落全链', () => {
    writeEntries(2)
    runCompact(root)
    const good = readFileSync(baseFile(), 'utf8')

    // 形态坏 / 内容自校不符 → bad_base（损坏不静默回落）
    writeFileSync(baseFile(), '{"v":1}')
    expect(() => loadAnchor(journalFile(), baseFile())).toThrow('bad_base')
    writeFileSync(
      baseFile(),
      good.replace(/"worldRev":"[0-9a-f]+"/, `"worldRev":"${'f'.repeat(64)}"`),
    )
    expect(() => loadAnchor(journalFile(), baseFile())).toThrow('bad_base')

    // 快照位置与尾段不符（崩溃窗口）→ 回落全链，不砖化
    writeFileSync(
      baseFile(),
      good.replace(
        /"snapshot":\{"seq":\d+,"hash":"[0-9a-f]+"\}/,
        `"snapshot":{"seq":0,"hash":"${'a'.repeat(64)}"}`,
      ),
    )
    const fallenBack = loadAnchor(journalFile(), baseFile())
    expect(fallenBack.baseSeq).toBe(-1)
    expect(worldRev(fallenBack.world)).toBe(
      worldRev(replayFull(readAllEntries(journalFile(), coldDir()))),
    )

    writeFileSync(baseFile(), good)
    const fast = loadAnchor(journalFile(), baseFile())
    expect(fast.baseSeq).toBeGreaterThanOrEqual(0)
  })

  it('启动成本口径：全链 303 条压缩后，载入 entry 数 = 尾段 3（而非全链）；耗时随输出记录', () => {
    writeEntries(300)
    runCompact(root)
    appendEntries(2)
    const all = readAllEntries(journalFile(), coldDir())
    expect(all).toHaveLength(303)

    const beginBase = performance.now()
    const tail = loadAnchor(journalFile(), baseFile())
    const baseMs = performance.now() - beginBase
    const beginFull = performance.now()
    const full = replayFull(all)
    const fullMs = performance.now() - beginFull

    // 结构证明：启动只吃尾段（3 条），不吃全链（303 条）
    expect(tail.entries).toHaveLength(3)
    expect(worldRev(tail.world)).toBe(worldRev(full))
    console.log(
      `[G6] 全链 303：基础世界载入=${baseMs.toFixed(1)}ms（尾段 3） 全量重放=${fullMs.toFixed(1)}ms`,
    )
    // 宽松护栏（只防病态回归；真实值见输出）
    expect(baseMs).toBeLessThan(fullMs + 50)
  })
})
