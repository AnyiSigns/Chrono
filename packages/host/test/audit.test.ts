// 声明式审计分档：`schema.audit_tier` 的解析（含框架上限截断）与按声明分档的淘汰行为。
// 档位随世界声明变，每次插入现查；未声明端口走 default 档。

import { describe, expect, it } from 'vitest'
import {
  AUDIT_DEFAULT_TIER,
  AUDIT_MAX_BYTES,
  AUDIT_MAX_RECORDS,
  AUDIT_TIER_MAX_BYTES,
  AUDIT_TIER_MAX_RECORDS,
  AuditIndex,
} from '../audit.ts'
import { resolveAuditTier } from '../audit-tiers.ts'
import type { Json, World } from '../../kernel/index.ts'

const SCHEMA_HASH = 's'.repeat(64)

/** 造一个只含单个 active 身份、schema 声明了 `audit_tier` 的世界。 */
function worldWithTiers(tiers: Json): World {
  return {
    defs: { [SCHEMA_HASH]: { body: { type: 'object', audit_tier: tiers } } },
    ids: {
      svc: {
        id: 'svc',
        schema: SCHEMA_HASH,
        gens: [],
        active: 'g'.repeat(64),
        born: { at: 1, by: 'test' },
      },
    },
  }
}

/**
 * 两个 active 身份对同一能力类 `cap` 各声明一份 `audit_tier`：`aaa` 预算更大、`bbb` 更小。
 * `ids` 插入序为 `bbb` → `aaa`（非字典序），用于验证首命中按身份名字典序。
 */
function worldWithTwoTiers(): World {
  const schemaA = 'a'.repeat(64)
  const schemaB = 'b'.repeat(64)
  return {
    defs: {
      [schemaA]: {
        body: { type: 'object', audit_tier: { cap: { max_records: 20, max_bytes: 2000 } } },
      },
      [schemaB]: {
        body: { type: 'object', audit_tier: { cap: { max_records: 10, max_bytes: 1000 } } },
      },
    },
    ids: {
      bbb: {
        id: 'bbb',
        schema: schemaB,
        gens: [],
        active: 'g'.repeat(64),
        born: { at: 1, by: 'test' },
      },
      aaa: {
        id: 'aaa',
        schema: schemaA,
        gens: [],
        active: 'g'.repeat(64),
        born: { at: 1, by: 'test' },
      },
    },
  }
}

function draftPort(
  port: string,
  run: string,
): {
  at: number
  by: string
  body: Json
} {
  return {
    at: 1000,
    by: 'host',
    body: { kind: 'effect_audit', run, emitter: 'toy', outcome: 'ok', port },
  }
}

describe('声明式审计分档（schema.audit_tier）', () => {
  it('声明端口取自己的预算；未声明端口 → undefined（default 档）', () => {
    const world = worldWithTiers({
      'storage-sql': { max_records: 3000, max_bytes: 2 * 1024 * 1024 },
    })
    expect(resolveAuditTier(world, 'storage-sql')).toEqual({
      maxRecords: 3000,
      maxBytes: 2 * 1024 * 1024,
    })
    expect(resolveAuditTier(world, 'approval')).toBeUndefined()
  })

  it('自报超上限的预算被截到框架上限（防绕过保留纪律）', () => {
    const world = worldWithTiers({
      greedy: { max_records: 1_000_000_000, max_bytes: 1_000_000_000 },
    })
    expect(resolveAuditTier(world, 'greedy')).toEqual({
      maxRecords: AUDIT_TIER_MAX_RECORDS,
      maxBytes: AUDIT_TIER_MAX_BYTES,
    })
  })

  it('非法声明（缺字段 / 非正整数 / 非对象）按未声明处理', () => {
    const world = worldWithTiers({
      bad1: { max_records: 10 },
      bad2: { max_records: 0, max_bytes: 100 },
      bad3: { max_records: 1.5, max_bytes: 100 },
      bad4: 'nope',
    })
    expect(resolveAuditTier(world, 'bad1')).toBeUndefined()
    expect(resolveAuditTier(world, 'bad2')).toBeUndefined()
    expect(resolveAuditTier(world, 'bad3')).toBeUndefined()
    expect(resolveAuditTier(world, 'bad4')).toBeUndefined()
  })

  it('声明端口走自己的预算：单端口刷满不挤掉 default 档', () => {
    const world = worldWithTiers({ model: { max_records: 3, max_bytes: 1_000_000 } })
    const index = new AuditIndex({ tierBudgetOf: (port) => resolveAuditTier(world, String(port)) })
    index.add(record(draftPort('other', 'o0')))
    index.add(record(draftPort('other', 'o1')))
    for (let i = 0; i < 6; i++) index.add(record(draftPort('model', `m${i}`)))
    const runs = index.records().map((item) => (item.body as { run: string }).run)
    expect(runs).toContain('o0')
    expect(runs).toContain('o1')
    expect(runs.filter((run) => run.startsWith('m'))).toEqual(['m3', 'm4', 'm5'])
  })

  it('未声明端口走 default 档预算', () => {
    const world = worldWithTiers({})
    const index = new AuditIndex({
      tierBudgetOf: (port) => resolveAuditTier(world, String(port)),
      defaultBudget: { maxRecords: 2, maxBytes: 1_000_000 },
    })
    for (let i = 0; i < 4; i++) index.add(record(draftPort('approval', `a${i}`)))
    expect(index.size()).toBe(2)
    expect(index.records().map((item) => (item.body as { run: string }).run)).toEqual(['a2', 'a3'])
  })

  it('多身份声明同一能力类：首命中按身份名字典序，与插入序无关', () => {
    const world = worldWithTwoTiers()
    // 插入序非字典序：bbb 在前、aaa 在后
    expect(Object.keys(world.ids)).toEqual(['bbb', 'aaa'])
    expect(resolveAuditTier(world, 'cap')).toEqual({ maxRecords: 20, maxBytes: 2000 })
  })

  it('字典序遍历仍跳过 retired 与 schema def 缺失的身份', () => {
    const world = worldWithTwoTiers()
    // aaa 退役（active=null）→ 跳过，回落到字典序次者 bbb
    world.ids['aaa'] = { ...world.ids['aaa'], active: null }
    expect(resolveAuditTier(world, 'cap')).toEqual({ maxRecords: 10, maxBytes: 1000 })
    // bbb 的 schema def 缺失 → 跳过，无命中
    const ghost = worldWithTwoTiers()
    delete ghost.defs[ghost.ids['bbb'].schema]
    ghost.ids['aaa'] = { ...ghost.ids['aaa'], active: null }
    expect(resolveAuditTier(ghost, 'cap')).toBeUndefined()
  })

  it('声明值被截到上限后按上限淘汰', () => {
    const world = worldWithTiers({ greedy: { max_records: 1_000_000, max_bytes: 1_000_000_000 } })
    const index = new AuditIndex({ tierBudgetOf: (port) => resolveAuditTier(world, String(port)) })
    for (let i = 0; i < AUDIT_TIER_MAX_RECORDS + 1; i++) {
      index.add(record(draftPort('greedy', `g${i}`)))
    }
    expect(index.size()).toBe(AUDIT_TIER_MAX_RECORDS)
    const runs = index.records().map((item) => (item.body as { run: string }).run)
    expect(runs[0]).toBe('g1')
  })
})

describe('审计保留窗口口径：全局单档 ≠ 分档 default 档', () => {
  it('单档全局窗口 = AUDIT_MAX_*（10000 / 8 MiB）', () => {
    expect(AUDIT_MAX_RECORDS).toBe(10_000)
    expect(AUDIT_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(new AuditIndex({}).budgetTotals()).toEqual({
      maxRecords: AUDIT_MAX_RECORDS,
      maxBytes: AUDIT_MAX_BYTES,
    })
  })

  it('分档生效：未声明端口落到 default 档 = AUDIT_DEFAULT_TIER（1000 / 512 KiB）', () => {
    expect(AUDIT_DEFAULT_TIER).toEqual({ maxRecords: 1000, maxBytes: 512 * 1024 })
    expect(new AuditIndex({ tierBudgetOf: () => undefined }).budgetTotals()).toEqual(
      AUDIT_DEFAULT_TIER,
    )
    const index = new AuditIndex({ tierBudgetOf: () => undefined })
    for (let i = 0; i < 1_005; i++) index.add(record(draftPort('approval', `a${i}`)))
    expect(index.size()).toBe(AUDIT_DEFAULT_TIER.maxRecords)
    expect((index.records()[0].body as { run: string }).run).toBe('a5')
  })
})

function record(draft: { at: number; by: string; body: Json }) {
  return { seq: 0, at: draft.at, by: draft.by, body: draft.body }
}
