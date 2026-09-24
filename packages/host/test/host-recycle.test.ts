// 有界化与回收底座验收（宿主侧）：
// - AuditIndex 保留窗口（条数 / 字节）淘汰最旧，查询只见保留集；
// - compact 写 base 时按可达性回收 def + 裁世代窗口，未达 def 不写进新 base；
// - 审计 def 不再是世界内容 / 世界根：compact 机械摘除，冷段全链 verify 仍过；
// - 回收后 base 可载入（pruned 子世界）、全链 verify 仍过、续写仍可校验。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_HEAD, commit, worldRev } from '../../kernel/index.ts'
import type { Entry, Hash, Head, Op, Json, World } from '../../kernel/index.ts'
import {
  appendJournal,
  readAllEntries,
  readBase,
  readJournal,
  replayFull,
  verifyFull,
  writeBase,
} from '../ledger/index.ts'
import { loadAnchor } from '../ledger/index.ts'
import { AuditIndex } from '../audit.ts'
import { compactWorld } from '../compact.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

function auditRecord(
  seq: number,
  run: string,
): { seq: number; at: number; by: string; body: Json } {
  return {
    seq,
    at: 1000 + seq,
    by: 'host',
    body: { kind: 'effect_audit', run, emitter: 'toy', outcome: 'ok' },
  }
}

describe('AuditIndex 保留窗口', () => {
  it('超过条数上限淘汰最旧；query 只见保留集；次级索引同步淘汰', () => {
    const index = new AuditIndex({ maxRecords: 3 })
    for (let i = 0; i < 5; i++) index.add(auditRecord(i, `run-${i}`))
    expect(index.records().map((r) => r.seq)).toEqual([2, 3, 4])
    expect(index.size()).toBe(3)
    const report = index.query({})
    expect(report.records.map((r) => r.seq)).toEqual([4, 3, 2])
    expect(report.truncated).toBe(false)
    // 次级索引同步淘汰：按 run 过滤看不到被淘汰项
    expect(index.query({ run: 'run-0' }).records).toEqual([])
    expect(index.query({ run: 'run-4' }).records.map((r) => r.seq)).toEqual([4])
  })

  it('超过字节上限同样淘汰最旧', () => {
    const index = new AuditIndex({ maxRecords: 1000, maxBytes: 10 })
    index.add(auditRecord(0, 'a'))
    expect(index.records()).toEqual([])
    expect(index.size()).toBe(0)
  })

  it('淘汰标记可清除（侧存压实后）', () => {
    const index = new AuditIndex({ maxRecords: 1 })
    index.add(auditRecord(0, 'a'))
    index.add(auditRecord(1, 'b'))
    expect(index.hadEviction()).toBe(true)
    index.clearEvicted()
    expect(index.hadEviction()).toBe(false)
  })
})

describe('compact 有界化回收', () => {
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

  interface Fixture {
    world: World
    head: Head
    schema: Hash
    gens: Hash[]
    orphan: Hash
    audit: Hash
  }

  /** 造一条链：schema + 身份 x 的三个世代 + 无根 def + 审计 def。 */
  function fixture(): Fixture {
    const world = { defs: {}, ids: {} } as World
    let head: Head = { ...EMPTY_HEAD }
    const entries: Entry[] = []
    const push = (op: Op, args: Json): Hash => {
      const outcome = commit(
        head,
        world,
        { id: `t-${entries.length}`, op, target: { expect_pos: head.hash }, args, by: 't' },
        1000 + entries.length,
      )
      if (!outcome.verdict.ok || outcome.entry === null || outcome.hash === null) {
        throw new Error(`commit failed: ${outcome.verdict.reasons.join(',')}`)
      }
      head = { seq: outcome.entry.seq, hash: outcome.hash as Hash }
      entries.push(outcome.entry)
      return outcome.entry.argsHash // put 的 def 键（链位置哈希另算）
    }
    const schema = push('put', { body: { schema: true } })
    const gens = [
      push('put', { body: { gen: 0 } }),
      push('put', { body: { gen: 1 } }),
      push('put', { body: { gen: 2 } }),
    ]
    push('add_identity', { id: 'x', schema })
    for (const payload of gens) push('add_gen', { id: 'x', payload, pins: {}, sig: schema })
    const orphan = push('put', { body: { orphan: true } })
    const audit = push('put', {
      body: { kind: 'effect_audit', run: 'r', emitter: 'x', outcome: 'ok' },
    })
    appendJournal(journalFile(), entries)
    return { world, head, schema, gens, orphan, audit }
  }

  function compact(fx: Fixture, retention: Parameters<typeof compactWorld>[5]) {
    const paths = hostPaths(root)
    const entries = readJournal(journalFile())
    const world = replayFull(entries)
    return compactWorld(paths, world, fx.head, entries, Date.now(), retention)
  }

  it('世代窗口：窗口外世代与仅其引用的 def 不写进新 base；审计 def 摘除；全链 verify 仍过', () => {
    const fx = fixture()
    const result = compact(fx, { genWindow: 1 })
    expect(result.recycled.droppedGens).toBe(2)
    expect(result.world.ids.x.gens.map((g) => g.payload)).toEqual([fx.gens[2]])
    expect(result.world.defs[fx.gens[0]]).toBeUndefined()
    expect(result.world.defs[fx.gens[1]]).toBeUndefined()
    expect(result.world.defs[fx.gens[2]]).toBeDefined()
    expect(result.world.defs[fx.schema]).toBeDefined()
    // 审计不再是世界内容：compact 机械摘除
    expect(result.world.defs[fx.audit]).toBeUndefined()
    // 保守口径：从未被任何根引用的业务 def（orphan）不碰
    expect(result.world.defs[fx.orphan]).toBeDefined()

    expect(existsSync(baseFile())).toBe(true)
    const tail = loadAnchor(journalFile(), baseFile(), coldDir())
    expect(tail.pruned).toBe(true)
    expect(worldRev(tail.world)).toBe(worldRev(result.world))
    // 全链（冷段 + 尾段）从空世界重放：快照 entry 的全量 world_rev 自校仍过
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
  })

  it('严格模式回收所有不在保留闭包内的 def（含审计与 orphan）', () => {
    const fx = fixture()
    const result = compact(fx, { genWindow: 1, strict: true })
    expect(result.world.defs[fx.orphan]).toBeUndefined()
    expect(result.world.defs[fx.audit]).toBeUndefined()
    expect(result.world.defs[fx.gens[2]]).toBeDefined()
  })

  it('回收后 base 可续写：以回收世界为起点 append 新 entry，重载与全链 verify 一致', () => {
    const fx = fixture()
    const result = compact(fx, { genWindow: 1 })
    // 以回收世界 + 快照链头续写一条新 def
    const next = commit(
      { seq: result.snapshot.seq, hash: result.snapshot.hash },
      result.world,
      {
        id: 'after',
        op: 'put',
        target: { expect_pos: result.snapshot.hash },
        args: { body: { after: 1 } },
        by: 't',
      },
      9999,
    )
    if (!next.verdict.ok || next.entry === null) throw new Error('append commit failed')
    appendJournal(journalFile(), [next.entry])

    const tail = loadAnchor(journalFile(), baseFile(), coldDir())
    expect(tail.world.ids.x.gens).toHaveLength(1)
    expect(tail.head.seq).toBe(next.entry.seq)
    expect(verifyFull(readAllEntries(journalFile(), coldDir())).ok).toBe(true)
    // 续写世界 = 回收世界 + 新 entry（与全量重放不同：回收是策略，全量重放仍含历史 def）
    expect(worldRev(tail.world)).not.toBe(
      worldRev(replayFull(readAllEntries(journalFile(), coldDir()))),
    )
  })
})

describe('base 审计字段兼容', () => {
  let root: string
  beforeEach(() => {
    root = createTempRoot()
  })
  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('老 base 携带 audits 数组仍可读；审计 def 被当作不可达，不影响载入', () => {
    const baseFile = join(root, 'state', 'world', 'base.json')
    const world: World = {
      defs: {
        ['a'.repeat(64)]: { body: { kind: 'effect_audit', run: 'old' } },
        ['b'.repeat(64)]: { body: { keep: true } },
      },
      ids: {},
    }
    writeBase(baseFile, { snapshot: { seq: 3, hash: 'c'.repeat(64) }, world })
    // 注入老字段 audits（审计曾进世界）：新读侧忽略，不报错
    const parsed = JSON.parse(readFileSync(baseFile, 'utf8')) as Record<string, unknown>
    parsed['audits'] = [{ seq: 1, at: 1, by: 'host', hash: 'a'.repeat(64) }]
    writeFileSync(baseFile, JSON.stringify(parsed))

    const base = readBase(baseFile)
    expect(base).not.toBeNull()
    expect(base!.snapshot.seq).toBe(3)
    expect(worldRev(base!.world)).toBe(worldRev(world))
  })

  it('老 base 的 audits 指向已摘除 def 也不报错（fail-open）', () => {
    const baseFile = join(root, 'state', 'world', 'base.json')
    const world: World = { defs: { ['b'.repeat(64)]: { body: { keep: true } } }, ids: {} }
    writeBase(baseFile, { snapshot: { seq: 1, hash: 'c'.repeat(64) }, world })
    const parsed = JSON.parse(readFileSync(baseFile, 'utf8')) as Record<string, unknown>
    parsed['audits'] = [{ seq: 1, at: 1, by: 'host', hash: 'd'.repeat(64) }] // 不在 defs
    writeFileSync(baseFile, JSON.stringify(parsed))
    expect(() => readBase(baseFile)).not.toThrow()
  })
})
