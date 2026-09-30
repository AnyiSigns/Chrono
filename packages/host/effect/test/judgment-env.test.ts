// 判定内效果的调用帧 `env` 与审计 `run`/`by`：判定 term 发射 `eff` 经真实路由 + 真实
// `judgment-invoke` 链路命中可捕获端点，断言帧 `env` 带外层 run、`emitter` 覆写为判定属主、
// 审计草稿的 `run`/`by` 与外层 run / 判定属主同源。边界：无外层 env 时不填帧、不抛。

import { describe, expect, it } from 'vitest'
import { assemblyGen } from '../../assembly/index.ts'
import { EndpointTable } from '../../endpoint-table.ts'
import { createJudgmentInvoke } from '../judgment-invoke.ts'
import { createJudgmentRunner } from '../judgment.ts'
import { createRoundRouter } from '../route.ts'
import { DEFAULT_LIMITS } from '../../run-registry.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { AuditDraft } from '../../audit.ts'
import type { CallEnv } from '../../wire.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Json, World } from '../../../kernel/index.ts'

/** 外层正向调用帧（非 run-loop 驱动时为 undefined）。 */
const OUTER: CallEnv = { run: 'run-42', thread: 'th-1', now: 1234, emitter: 'caller' }
/** `createJudgmentInvoke` 的宿主固定时钟：仅在无外层 env 时回落，用于验证时钟同源。 */
const CLOCK = 987_654

interface Captured {
  port: string
  method: string
  args: Json
  env: CallEnv | undefined
}

interface Fixture {
  root: string
  world: World
  router: ReturnType<typeof createRoundRouter>
  calls: Captured[]
  drafts: AuditDraft[]
  close: () => Promise<void>
}

function endpointRow(
  impl: string,
  gen: string,
  cap: string,
  method: string,
  calls: Captured[],
): EndpointRow {
  return {
    impl,
    gen,
    cap,
    method,
    transport: 'stdio',
    pid: 1,
    link: {
      call: async (_port, called, args, _timeoutMs, _signal, env) => {
        calls.push({ port: _port, method: called, args, env })
        return { ok: true, value: { echo: args } }
      },
    },
  }
}

/** 单判定夹具：judge 自身实现 `self`，`self.probe` 由 term 承载并发 `eff` 到自身 `self.x` 端点。 */
async function singleFixture(): Promise<Fixture> {
  const root = createTempRoot()
  try {
    const pkg = writeTempPackage(root, {
      identity: 'judge',
      implements: ['self'],
      methods: { self: ['probe', 'x'] },
      judgments: { self: { probe: 'terms/probe.json' } },
      terms: { 'probe.json': JSON.stringify(['eff', 'self', 'x', ['c', 7]]) },
    })
    if (!runSeed(root, [{ name: 'judge', path: pkg }]).ok) throw new Error('seed failed')
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    const gen = assemblyGen(world, 'judge')
    if (gen === null) throw new Error('judge has no assembly gen')
    const calls: Captured[] = []
    const drafts: AuditDraft[] = []
    const endpoints = new EndpointTable()
    endpoints.add(endpointRow('judge', gen.payload, 'self', 'x', calls))
    let router: ReturnType<typeof createRoundRouter>
    const invoke = createJudgmentInvoke({
      getRouter: () => router,
      blobsDir: hostPaths(root).blobsDir,
      now: () => CLOCK,
      onAudit: (draft) => drafts.push(draft),
    })
    router = createRoundRouter({
      endpoints,
      blobsDir: hostPaths(root).blobsDir,
      judgment: createJudgmentRunner(DEFAULT_LIMITS, { invoke }),
    })
    return { root, world, router, calls, drafts, close: () => cleanupTempRoot(root) }
  } catch (err) {
    await cleanupTempRoot(root)
    throw err
  }
}

/** 递归夹具：judgeA 的判定发 `eff` 到 judgeB 的判定 `b.cap.serve2`，B 再发 `eff` 到自身端点 `b.cap.x2`。 */
async function recursionFixture(): Promise<Fixture> {
  const root = createTempRoot()
  try {
    const pkgA = writeTempPackage(root, {
      identity: 'judgeA',
      implements: ['a.cap'],
      methods: { 'a.cap': ['serve'] },
      judgments: { 'a.cap': { serve: 'terms/a.json' } },
      needs: { 'b.cap': { mode: 'one' } },
      terms: { 'a.json': JSON.stringify(['eff', 'b.cap', 'serve2', ['c', 7]]) },
    })
    const pkgB = writeTempPackage(root, {
      identity: 'judgeB',
      implements: ['b.cap'],
      methods: { 'b.cap': ['serve2', 'x2'] },
      judgments: { 'b.cap': { serve2: 'terms/b.json' } },
      terms: { 'b.json': JSON.stringify(['eff', 'b.cap', 'x2', ['c', 9]]) },
    })
    if (
      !runSeed(root, [
        { name: 'judgeA', path: pkgA },
        { name: 'judgeB', path: pkgB },
      ]).ok
    ) {
      throw new Error('seed failed')
    }
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    const genB = assemblyGen(world, 'judgeB')
    if (genB === null) throw new Error('judgeB has no assembly gen')
    const calls: Captured[] = []
    const drafts: AuditDraft[] = []
    const endpoints = new EndpointTable()
    endpoints.add(endpointRow('judgeB', genB.payload, 'b.cap', 'x2', calls))
    let router: ReturnType<typeof createRoundRouter>
    const invoke = createJudgmentInvoke({
      getRouter: () => router,
      blobsDir: hostPaths(root).blobsDir,
      now: () => CLOCK,
      onAudit: (draft) => drafts.push(draft),
    })
    router = createRoundRouter({
      endpoints,
      blobsDir: hostPaths(root).blobsDir,
      judgment: createJudgmentRunner(DEFAULT_LIMITS, { invoke }),
    })
    return { root, world, router, calls, drafts, close: () => cleanupTempRoot(root) }
  } catch (err) {
    await cleanupTempRoot(root)
    throw err
  }
}

function judgeRow(fixture: Fixture, emitter: string, cap: string, method: string): EndpointRow {
  const outcome = fixture.router.resolve(fixture.world, emitter, cap, method)
  if (!outcome.ok) throw new Error(`resolve failed: ${outcome.error}`)
  return outcome.row
}

function bodyOf(draft: AuditDraft): { [k: string]: Json } {
  return draft.body as { [k: string]: Json }
}

describe('判定内效果的调用帧 env 与审计 run/by', () => {
  it('帧 env 带外层 run/thread/now，emitter 覆写为判定属主；审计 run/by 同源', async () => {
    const fixture = await singleFixture()
    try {
      const row = judgeRow(fixture, 'judge', 'self', 'probe')
      const response = await row.link.call('self', 'probe', null, 1000, undefined, OUTER)
      expect(response).toEqual({ ok: true, value: { echo: 7 } })
      // ① 端点收到的帧 env：run/thread/now 取外层，emitter = 判定属主 judge（非外层 caller）
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.env).toEqual({
        run: 'run-42',
        thread: 'th-1',
        now: 1234,
        emitter: 'judge',
      })
      // ② 审计草稿：body.run = 外层 run、by/emitter = 判定属主；at 与帧同源（外层 now）
      expect(fixture.drafts).toHaveLength(1)
      const draft = fixture.drafts[0]!
      expect(draft.by).toBe('judge')
      expect(draft.at).toBe(1234)
      const body = bodyOf(draft)
      expect(body['run']).toBe('run-42')
      expect(body['emitter']).toBe('judge')
      expect(body['outcome']).toBe('ok')
    } finally {
      await fixture.close()
    }
  })

  it('无外层 env：判定内调用不填帧、不抛；审计 run=null 且时钟回落宿主时钟', async () => {
    const fixture = await singleFixture()
    try {
      const row = judgeRow(fixture, 'judge', 'self', 'probe')
      const response = await row.link.call('self', 'probe', null, 1000)
      expect(response).toEqual({ ok: true, value: { echo: 7 } })
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.env).toBeUndefined()
      expect(fixture.drafts).toHaveLength(1)
      const draft = fixture.drafts[0]!
      expect(draft.by).toBe('judge')
      // 无外层 now：时间戳回落宿主固定时钟（与 options.now() 同源）
      expect(draft.at).toBe(CLOCK)
      const body = bodyOf(draft)
      expect(body['run']).toBeNull()
      expect(body['emitter']).toBe('judge')
    } finally {
      await fixture.close()
    }
  })

  it('递归 A→B：run 逐层保留，emitter 逐层覆写为当前判定属主，各层各留审计', async () => {
    const fixture = await recursionFixture()
    try {
      const row = judgeRow(fixture, 'judgeA', 'a.cap', 'serve')
      const response = await row.link.call('a.cap', 'serve', null, 1000, undefined, OUTER)
      expect(response).toEqual({ ok: true, value: { echo: 9 } })
      // 最内层端点帧 env：run 仍来自最外层，emitter = 当前（最内层）判定属主 judgeB
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.env).toEqual({
        run: 'run-42',
        thread: 'th-1',
        now: 1234,
        emitter: 'judgeB',
      })
      // 两层各留一条审计：by/emitter 分别是各层判定属主，run 同外层 run
      const byOwner = new Map(fixture.drafts.map((draft) => [draft.by, draft]))
      expect([...byOwner.keys()].sort()).toEqual(['judgeA', 'judgeB'])
      for (const owner of ['judgeA', 'judgeB']) {
        const draft = byOwner.get(owner)!
        expect(draft.at).toBe(1234)
        const body = bodyOf(draft)
        expect(body['run']).toBe('run-42')
        expect(body['emitter']).toBe(owner)
      }
    } finally {
      await fixture.close()
    }
  })
})
