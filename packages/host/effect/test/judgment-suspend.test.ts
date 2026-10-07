// 休眠身份的判定方法可路由性（F-24）：休眠 = 运行期隔离，服务端点被摘除；判定不住端点表，
// 故 router 须按运行态休眠集一并摘除其判定路由，且在自能力 / 按成员定位 / many 槽三条路径口径一致。

import { describe, expect, it } from 'vitest'
import { createJudgmentRunner } from '../judgment.ts'
import { createRoundRouter } from '../route.ts'
import { EndpointTable } from '../../endpoint-table.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { World } from '../../../kernel/index.ts'

interface Fixture {
  world: World
  suspended: Set<string>
  router: ReturnType<typeof createRoundRouter>
  close: () => Promise<void>
}

/** provider 的 `ext.hook.probe` 由 term 承载；consumer 以 many 声明消费 `ext.hook`。 */
async function fixture(): Promise<Fixture> {
  const root = createTempRoot()
  try {
    const provider = writeTempPackage(root, {
      identity: 'provider',
      implements: ['ext.hook'],
      methods: { 'ext.hook': ['probe'] },
      judgments: { 'ext.hook': { probe: 'terms/probe.json' } },
      terms: { 'probe.json': JSON.stringify(['c', 1]) },
    })
    const consumer = writeTempPackage(root, {
      identity: 'consumer',
      needs: { 'ext.hook': { mode: 'many', methods: ['probe'] } },
    })
    const report = runSeed(root, [
      { name: 'provider', path: provider },
      { name: 'consumer', path: consumer },
    ])
    if (!report.ok) throw new Error(`seed failed: ${JSON.stringify(report.items)}`)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    const suspended = new Set<string>()
    const router = createRoundRouter({
      endpoints: new EndpointTable(),
      blobsDir: hostPaths(root).blobsDir,
      suspended: () => suspended,
      judgment: createJudgmentRunner({ gas: 1_000_000, depth: 64 }),
    })
    return { world, suspended, router, close: () => cleanupTempRoot(root) }
  } catch (err) {
    await cleanupTempRoot(root)
    throw err
  }
}

describe('休眠身份的判定路由', () => {
  it('自能力：休眠前可路由到判定行，休眠后 not_loaded，恢复后恢复', async () => {
    const f = await fixture()
    try {
      const before = f.router.resolve(f.world, 'provider', 'ext.hook', 'probe')
      expect(before.ok).toBe(true)
      if (before.ok) expect(before.row.transport).toBe('term')

      f.suspended.add('provider')
      expect(f.router.resolve(f.world, 'provider', 'ext.hook', 'probe')).toEqual({
        ok: false,
        error: 'not_loaded',
      })

      f.suspended.delete('provider')
      expect(f.router.resolve(f.world, 'provider', 'ext.hook', 'probe').ok).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('按成员定位（反向 many）：休眠成员判定不可路由，恢复后可路由', async () => {
    const f = await fixture()
    try {
      const before = f.router.resolve(f.world, 'consumer', 'ext.hook', 'probe', 'provider')
      expect(before.ok).toBe(true)

      f.suspended.add('provider')
      expect(f.router.resolve(f.world, 'consumer', 'ext.hook', 'probe', 'provider')).toEqual({
        ok: false,
        error: 'not_loaded',
      })

      f.suspended.delete('provider')
      expect(f.router.resolve(f.world, 'consumer', 'ext.hook', 'probe', 'provider').ok).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('many 槽成员含判定：休眠成员该元素 not_loaded，其余成员不受影响', async () => {
    const f = await fixture()
    try {
      const before = f.router.resolveSlot?.(f.world, 'consumer', 'ext.hook', 'probe')
      expect(before?.members).toEqual([
        { provider: 'provider', ok: true, row: expect.objectContaining({ transport: 'term' }) },
      ])

      f.suspended.add('provider')
      expect(f.router.resolveSlot?.(f.world, 'consumer', 'ext.hook', 'probe')?.members).toEqual([
        { provider: 'provider', ok: false, error: 'not_loaded' },
      ])

      f.suspended.delete('provider')
      expect(f.router.resolveSlot?.(f.world, 'consumer', 'ext.hook', 'probe')?.members[0]?.ok).toBe(
        true,
      )
    } finally {
      await f.close()
    }
  })
})
