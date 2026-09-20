// H12 run 级并发验收：多个 run 同时推进（eval / 等待服务调用并发），提交只在落账那一刻串行。
// 构造两个并发命令，其服务调用有可观测延迟；断言都完成、两条业务写都落链、链完整、
// 重放世界与账本一致（非自证：账本独立重放 vs 基础世界重放）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { headOf, loadAnchor, readJournal, replayFull, verifyFull } from '../ledger/index.ts'
import { worldRev } from '../../kernel/index.ts'
import type { Entry, Json } from '../../kernel/index.ts'
import { cleanupTempRoot, createTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

/** 命令入口：先发 eff（服务延迟），再返回 plan（plan 里带一条不同的业务 put）。 */
const RUN_A: Json = [
  'call',
  ['c', { $ref: 'terms/planA.json' }],
  [['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]],
]
const RUN_B: Json = [
  'call',
  ['c', { $ref: 'terms/planB.json' }],
  [['eff', 'toy.alpha', 'echo', ['c', { n: 2 }]]],
]

const PLAN_A: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { who: 'a' } } } }] },
]
const PLAN_B: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { who: 'b' } } } }] },
]

/** 服务调用可观测延迟：串行两个 run 会 ≥ 2×；并发则 ≈ 1×。 */
const CALL_DELAY_MS = 1000

describe('H12 run 级并发：提交串行、eval / 效果并发', () => {
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

  function seed(): void {
    const slow = writeTempPackage(root, {
      identity: 'toy-slow',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callDelayMs: CALL_DELAY_MS },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.alpha': 'toy-slow' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [
        { name: 'toy-caller.run.a', entry: 'terms/runA.json' },
        { name: 'toy-caller.run.b', entry: 'terms/runB.json' },
      ],
      terms: {
        'runA.json': JSON.stringify(RUN_A),
        'planA.json': JSON.stringify(PLAN_A),
        'runB.json': JSON.stringify(RUN_B),
        'planB.json': JSON.stringify(PLAN_B),
      },
    })
    const report = runSeed(root, [
      { name: 'toy-slow', path: slow },
      { name: 'toy-caller', path: caller },
    ])
    expect(report.ok).toBe(true)
  }

  it('两个并发命令：都完成、两条业务写同链、重放与账本一致', async () => {
    seed()
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 10_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 5000 })
    let entries: Entry[] = []
    try {
      const startedAt = Date.now()
      const [first, second] = await Promise.all([
        client.command('toy-caller.run.a'),
        client.command('toy-caller.run.b'),
      ])
      const elapsed = Date.now() - startedAt
      expect(first.status).toBe('done')
      expect(second.status).toBe('done')
      // 并发证据：两个服务调用重叠，耗时明显低于串行下界（两次调用 = 2×延迟）
      expect(elapsed).toBeLessThan(2 * CALL_DELAY_MS - CALL_DELAY_MS / 2)

      entries = readJournal(journalFile())
      const status = await client.status()
      expect(status.world_head).toEqual(headOf(entries))
      // 宿主落账世界 = 账本独立重放世界（有效断言，非自证）
      expect(status.world_rev).toBe(worldRev(replayFull(entries)))
    } finally {
      client.close()
    }

    expect(verifyFull(entries).ok).toBe(true)
    const added = entries.slice(before)
    // 每个 run 各一条审计 + 一条业务写
    expect(added).toHaveLength(4)
    const auditCount = added.filter(
      (entry) => (entry.args as { body?: { kind?: string } }).body?.kind === 'effect_audit',
    ).length
    expect(auditCount).toBe(2)
    const bodies = added
      .map((entry) => (entry.args as { body?: { who?: string } }).body?.who)
      .filter((who): who is string => who !== undefined)
      .sort()
    expect(bodies).toEqual(['a', 'b'])
    // 提交串行：seq 逐条递增，prev 两两接链
    for (let i = 1; i < added.length; i++) {
      expect(added[i].seq).toBe(added[i - 1].seq + 1)
    }
    // 重放一致：账本独立重放的世界摘要 = 基础世界重放的世界摘要
    expect(worldRev(replayFull(entries))).toBe(worldRev(loadAnchor(journalFile()).world))
  }, 30000)

  it('并发写：一个慢 run 与一个纯写 run 交错落账，链仍逐字节可校验', async () => {
    seed()
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 10_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 5000 })
    let entries: Entry[] = []
    try {
      const [slow, fast] = await Promise.all([
        client.command('toy-caller.run.a'),
        client.submit([
          {
            kind: 'write',
            request: {
              id: 'fast-write',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { who: 'fast' } },
              by: 'client',
            },
          },
        ]),
      ])
      expect(slow.status).toBe('done')
      expect(fast.status).toBe('done')
      entries = readJournal(journalFile())
      const status = await client.status()
      expect(status.world_head).toEqual(headOf(entries))
      expect(status.world_rev).toBe(worldRev(replayFull(entries)))
    } finally {
      client.close()
    }

    expect(verifyFull(entries).ok).toBe(true)
    const added = entries.slice(before)
    expect(added).toHaveLength(3)
    const fastEntry = added.find(
      (entry) => (entry.args as { body?: { who?: string } }).body?.who === 'fast',
    )
    const slowAudit = added.find(
      (entry) => (entry.args as { body?: { kind?: string } }).body?.kind === 'effect_audit',
    )
    // 纯写不等慢服务：它的 seq 必须先于慢 run 的审计落账
    expect(fastEntry).toBeDefined()
    expect(slowAudit).toBeDefined()
    expect(fastEntry!.seq).toBeLessThan(slowAudit!.seq)
    expect(worldRev(replayFull(entries))).toBe(worldRev(loadAnchor(journalFile()).world))
  }, 30000)
})
