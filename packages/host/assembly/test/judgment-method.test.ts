// 判定承载的方法（`plugin.json.judgments`）：路由命中就地求值 term，不 spawn 服务。
// 取证面：表达得出（与旧服务语义逐例一致）/ 跨身份（`one` needs）/ 纯项 fail-closed / 重放一致。
// 用真实 `plugins/router`（判定已整迁 term、服务已退化为无）与临时夹具包取证。
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EndpointTable } from '../../endpoint-table.ts'
import { createJudgmentRunner, createRoundRouter } from '../../effect/index.ts'
import { DEFAULT_LIMITS } from '../../run-registry.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { EndpointCallResult, EndpointRow } from '../../endpoint-table.ts'
import type { Json, World } from '../../../kernel/index.ts'

const ROUTER = fileURLToPath(new URL('../../../../plugins/router', import.meta.url))

/** 无服务的判定期望接线：空端点表 + 判定求值器（与宿主组合根同形）。 */
function judgmentRouter(root: string) {
  return createRoundRouter({
    endpoints: new EndpointTable(),
    blobsDir: hostPaths(root).blobsDir,
    judgment: createJudgmentRunner(DEFAULT_LIMITS),
  })
}

function resolveRow(root: string, world: World, emitter: string): EndpointRow {
  const outcome = judgmentRouter(root).resolve(world, emitter, 'router', 'select')
  if (!outcome.ok) throw new Error(`resolve failed: ${outcome.error}`)
  return outcome.row
}

function call(row: EndpointRow, args: Json): Promise<EndpointCallResult> {
  return row.link.call('router', 'select', args, 1000)
}

describe('判定承载的方法：路由命中 `judgments` 就地求值 term', () => {
  it('表达得出：真实 router 的判定逐例与旧服务语义一致，且端点无进程', async () => {
    const root = createTempRoot()
    try {
      expect(runSeed(root, [{ name: 'router', path: ROUTER }]).ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const row = resolveRow(root, world, 'router')
      expect(row.transport).toBe('term')
      expect(row.pid).toBeUndefined()

      // 无别名候选 → 主名（机械 no-op）
      expect(await call(row, { candidates: ['model'], failure: 'x' })).toEqual({
        ok: true,
        value: 'model',
      })
      // 有别名候选 → 候选清单顺序里第一个被声明的别名
      expect(
        await call(row, {
          candidates: ['model', 'model-alt', 'model-backup'],
          aliases: ['model-alt', 'model-backup'],
        }),
      ).toEqual({ ok: true, value: 'model-alt' })
      expect(
        await call(row, {
          candidates: ['model', 'model-backup', 'model-alt'],
          aliases: ['model-alt', 'model-backup'],
        }),
      ).toEqual({ ok: true, value: 'model-backup' })
      // args 可覆盖 primary / aliases
      expect(await call(row, { candidates: ['primary-x'], primary: 'primary-x' })).toEqual({
        ok: true,
        value: 'primary-x',
      })
      // 清单内既无主名也无别名 → 结构化 no_candidate
      expect(await call(row, { candidates: ['model-alt'] })).toEqual({
        ok: true,
        value: { ok: false, error: { code: 'no_candidate' } },
      })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('跨身份：消费方 `one` needs 解析到提供方的判定 term', async () => {
    const root = createTempRoot()
    try {
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { router: { mode: 'one' } },
      })
      expect(
        runSeed(root, [
          { name: 'router', path: ROUTER },
          { name: 'consumer', path: consumer },
        ]).ok,
      ).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const row = resolveRow(root, world, 'consumer')
      expect(row.impl).toBe('router')
      expect(row.transport).toBe('term')
      expect(await call(row, { candidates: ['a', 'b'], aliases: ['b'], primary: 'a' })).toEqual({
        ok: true,
        value: 'b',
      })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('纯项：判定发射 `eff` 即 fail-closed（取数 / 效果归服务方法）', async () => {
    const root = createTempRoot()
    try {
      const emitter = writeTempPackage(root, {
        identity: 'emitter',
        implements: ['self'],
        methods: { self: ['probe', 'x'] },
        judgments: { self: { probe: 'terms/probe.json' } },
        terms: { 'probe.json': JSON.stringify(['eff', 'self', 'x', ['c', null]]) },
      })
      expect(runSeed(root, [{ name: 'emitter', path: emitter }]).ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const outcome = judgmentRouter(root).resolve(world, 'emitter', 'self', 'probe')
      if (!outcome.ok) throw new Error(`resolve failed: ${outcome.error}`)
      const called = await outcome.row.link.call('self', 'probe', null, 1000)
      expect(called.ok).toBe(false)
      if (!called.ok) expect(called.code).toBe('bad_term')
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('判定可发射 `eff`：注入 invoke 执行并回灌续跑（与测试器同口径）', async () => {
    const ast: Json = [
      'if',
      ['pred', 'eq', ['eff', 'self', 'fetch', ['c', 7]], ['c', 7]],
      ['c', 'yes'],
      ['c', 'no'],
    ]
    const world = { defs: { entry1: { body: ast } }, ids: {} } as unknown as World
    const seen: Array<{ port: string; method: string; args: Json }> = []
    const runner = createJudgmentRunner(DEFAULT_LIMITS, {
      invoke: (_w, emitter, eff) => {
        seen.push({ port: eff.port, method: eff.method, args: eff.args })
        expect(emitter).toBe('owner')
        return Promise.resolve({ ok: true, value: 7 })
      },
    })
    const target = { owner: 'owner', gen: 'g', cap: 'self', method: 'probe', entry: 'entry1' }
    expect(await runner(world, target, null, 1000)).toEqual({ ok: true, value: 'yes' })
    expect(seen).toEqual([{ port: 'self', method: 'fetch', args: 7 }])
  })

  it('判定 def 缺失：求值器按 `not_loaded` 作数据错误（不猜）', async () => {
    const runner = createJudgmentRunner(DEFAULT_LIMITS)
    const called = await runner(
      { defs: {}, ids: {} },
      { owner: 'x', gen: 'g', cap: 'c', method: 'm', entry: '0'.repeat(64) },
      null,
      0,
    )
    expect(called).toEqual({ ok: false, code: 'not_loaded', message: expect.any(String) })
  })

  it('重放一致：同一入世世界重放后判定端点与决策逐字段一致', async () => {
    const root = createTempRoot()
    try {
      expect(runSeed(root, [{ name: 'router', path: ROUTER }]).ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const replayed = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const input: Json = { candidates: ['a', 'b'], aliases: ['b'], primary: 'a' }
      const first = await call(resolveRow(root, world, 'router'), input)
      const second = await call(resolveRow(root, replayed, 'router'), input)
      expect(second).toEqual(first)
    } finally {
      await cleanupTempRoot(root)
    }
  })
})
