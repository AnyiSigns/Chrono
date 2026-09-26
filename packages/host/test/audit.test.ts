// 声明式审计分档：`schema.audit_tier` 的解析（含框架上限截断）与按声明分档的淘汰行为。
// 档位随世界声明变，每次插入现查；未声明端口走 default 档。

import { describe, expect, it } from 'vitest'
import { AUDIT_TIER_MAX_BYTES, AUDIT_TIER_MAX_RECORDS, AuditIndex } from '../audit.ts'
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

function record(draft: { at: number; by: string; body: Json }) {
  return { seq: 0, at: draft.at, by: draft.by, body: draft.body }
}
