// 效果审计旁路侧存验收：追加 / 重载 / 保留淘汰 / 上限压实 / 半写安全 / 坏行跳过 / 查询等价。
// 侧存不进世界、不进链、不参与重放，故这些用例只验证侧存自身与其内存索引。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { H } from '../../kernel/index.ts'
import type { Entry, Hash, Json, World } from '../../kernel/index.ts'
import { AuditIndex } from '../audit.ts'
import type { AuditFilter, AuditRecord } from '../audit.ts'
import { AuditStore } from '../audit-store.ts'
import { backfillAuditStore, readAuditBackfillMeta } from '../audit-backfill.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

describe('AuditStore 旁路侧存', () => {
  let root: string
  let file: string

  beforeEach(() => {
    root = createTempRoot()
    file = join(root, 'state', 'audit', 'audit.jsonl')
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  function draft(run: string, outcome = 'ok', emitter = 'toy'): { at: number; by: string; body: Json } {
    return {
      at: 1000,
      by: 'host',
      body: { kind: 'effect_audit', run, emitter, outcome },
    }
  }

  function lines(): number {
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0).length
  }

  it('追加分配单调 seq；重载后索引与记录一致', () => {
    const store = AuditStore.open(file)
    const first = store.append(draft('r0'))
    const second = store.append(draft('r1'))
    expect(first.seq).toBe(0)
    expect(second.seq).toBe(1)
    expect(lines()).toBe(2)

    const reopened = AuditStore.open(file)
    expect(reopened.size()).toBe(2)
    expect(reopened.records().map((r) => r.seq)).toEqual([0, 1])
    // 续写接着已有 seq，不回退
    expect(reopened.append(draft('r2')).seq).toBe(2)
  })

  it('条数保留窗口：超限淘汰最旧，磁盘压实到保留集', () => {
    const store = AuditStore.open(file, { maxRecords: 3 })
    for (let i = 0; i < 6; i++) store.append(draft(`r${i}`))
    expect(store.records().map((r) => r.seq)).toEqual([3, 4, 5])
    // 压实阈值缺省为保留窗口两倍（8MiB×2），此处未触发；显式压实后磁盘只剩保留集
    store.compact()
    expect(lines()).toBe(3)
    const reopened = AuditStore.open(file, { maxRecords: 3 })
    expect(reopened.records().map((r) => r.seq)).toEqual([3, 4, 5])
  })

  it('字节保留窗口：超限淘汰最旧', () => {
    const store = AuditStore.open(file, { maxRecords: 1000, maxBytes: 10 })
    store.append(draft('a'))
    expect(store.records()).toEqual([])
    expect(store.size()).toBe(0)
  })

  it('磁盘压实阈值：超阈值即整文件重写为保留集', () => {
    const store = AuditStore.open(file, { maxRecords: 2, maxFileBytes: 1 })
    store.append(draft('a'))
    store.append(draft('b'))
    store.append(draft('c'))
    // 每次追加都超 1 字节阈值 → 立即压实，磁盘行数 = 保留集（≤2）
    expect(store.size()).toBe(2)
    expect(lines()).toBe(2)
  })

  it('半写安全：末行撕裂被丢弃并截断，随后追加不粘行', () => {
    const store = AuditStore.open(file)
    store.append(draft('ok'))
    appendFileSync(file, '{"seq":99,"at":1,"by":"x","body":{') // 撕裂尾：无换行、非法 JSON
    const reopened = AuditStore.open(file)
    expect(reopened.size()).toBe(1)
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
    expect(reopened.append(draft('after')).seq).toBe(1)
    expect(lines()).toBe(2)
  })

  it('带换行的坏行跳过（fail-open），不影响后续记录', () => {
    const store = AuditStore.open(file)
    store.append(draft('a'))
    appendFileSync(file, 'not-json\n')
    store.append(draft('b'))
    const reopened = AuditStore.open(file)
    expect(reopened.size()).toBe(2)
    expect(reopened.records().map((r) => (r.body as { run: string }).run)).toEqual(['a', 'b'])
  })

  it('查询等价：与 AuditIndex 同口径（run / emitter / outcome / limit / truncated / seq 降序）', () => {
    const store = AuditStore.open(file)
    const index = new AuditIndex()
    const specs: Array<[string, string, string]> = [
      ['r0', 'ok', 'x'],
      ['r1', 'error', 'y'],
      ['r1', 'transport_failed', 'x'],
      ['r2', 'ok', 'z'],
    ]
    for (const [run, outcome, emitter] of specs) {
      const record = store.append(draft(run, outcome, emitter))
      index.add(record)
    }
    const filters: AuditFilter[] = [
      {},
      { run: 'r1' },
      { emitter: 'x' },
      { outcome: 'ok' },
      { run: 'r1', outcome: 'error' },
      { limit: 2 },
    ]
    for (const filter of filters) {
      expect(store.query(filter)).toEqual(index.query(filter))
    }
    // seq 降序 + truncated
    const limited = store.query({ limit: 1 })
    expect(limited.records.map((r) => r.seq)).toEqual([3])
    expect(limited.truncated).toBe(true)
  })

  it('重载后淘汰：磁盘超出保留窗口即压实', () => {
    const store = AuditStore.open(file, { maxRecords: 5 })
    for (let i = 0; i < 5; i++) store.append(draft(`r${i}`))
    expect(lines()).toBe(5)
    const reopened = AuditStore.open(file, { maxRecords: 2 })
    expect(reopened.records().map((r) => r.seq)).toEqual([3, 4])
    expect(lines()).toBe(2)
  })

  it('空侧存：open 不创建文件；append 才落盘', () => {
    const store = AuditStore.open(file)
    expect(store.size()).toBe(0)
    expect(existsSync(file)).toBe(false)
    store.append(draft('a'))
    expect(existsSync(file)).toBe(true)
  })
})

describe('历史审计一次性回填', () => {
  let root: string
  beforeEach(() => {
    root = createTempRoot()
  })
  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  function auditDef(run: string): { def: { body: Json }; key: Hash } {
    const def = { body: { kind: 'effect_audit', run, emitter: 'toy', outcome: 'ok' } }
    return { def, key: H(def as unknown as Json) }
  }

  function putEntry(seq: number, at: number, by: string, def: { body: Json }): Entry {
    return {
      seq,
      prev: null,
      op: 'put',
      args: def as unknown as Json,
      argsHash: H(def as unknown as Json),
      by,
      at,
    }
  }

  it('扫 entry 的 put args 回填侧存、写 meta、二次调用幂等', () => {
    const paths = hostPaths(root)
    const a = auditDef('r-old')
    const world: World = { defs: { [a.key]: a.def }, ids: {} }
    const entry = putEntry(3, 111, 'host', a.def)
    const store = AuditStore.open(paths.auditFile)
    const report = backfillAuditStore(paths, world, [entry], store)
    expect(report.backfilled).toBe(1)
    expect(store.records()).toHaveLength(1)
    expect(store.records()[0]).toMatchObject({ seq: 0, at: 111, by: 'host' })
    expect((store.records()[0].body as { run: string }).run).toBe('r-old')
    expect(readAuditBackfillMeta(paths.auditMetaFile)).toEqual({
      backfilled: true,
      throughEntrySeq: 3,
    })
    // 幂等：再次调用不重复追加；重载侧存仍见
    expect(backfillAuditStore(paths, world, [entry], store).backfilled).toBe(0)
    expect(store.records()).toHaveLength(1)
    expect(AuditStore.open(paths.auditFile).size()).toBe(1)
  })

  it('仅存于 base world 的审计 def（无对应 entry）也回填', () => {
    const paths = hostPaths(root)
    const a = auditDef('r-base')
    const world: World = { defs: { [a.key]: a.def }, ids: {} }
    const store = AuditStore.open(paths.auditFile)
    expect(backfillAuditStore(paths, world, [], store).backfilled).toBe(1)
    expect(store.records()).toHaveLength(1)
    expect((store.records()[0].body as { run: string }).run).toBe('r-base')
  })

  it('窗口裁剪：按 entry seq 升序重建，超出保留窗口从新到旧取', () => {
    const paths = hostPaths(root)
    const defs: Record<Hash, { body: Json }> = {}
    const entries: Entry[] = []
    for (let i = 0; i < 5; i++) {
      const a = auditDef(`r-${i}`)
      defs[a.key] = a.def
      entries.push(putEntry(i, 1000 + i, 'host', a.def))
    }
    const world: World = { defs, ids: {} }
    const store = AuditStore.open(paths.auditFile)
    const report = backfillAuditStore(paths, world, entries, store, { maxRecords: 2 })
    expect(report.backfilled).toBe(2)
    expect(store.records().map((r) => (r.body as { run: string }).run)).toEqual(['r-3', 'r-4'])
  })
})
