// 判定热改验收（计划步骤 7 的三条验收之二三）：改判定 = 仅 `term` 成员变化 → 换代判据 `data`
// （进程热生效、不起新服务）；判定承载的方法无进程（`transport='term'`、无 pid）；下一代世界路由到新判定；
// 重放一致。用临时夹具包（服务无、判定住 term）取证。
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { EndpointTable } from '../../endpoint-table.ts'
import { createJudgmentRunner, createRoundRouter } from '../../effect/index.ts'
import { classifyGenerationChange } from '../index.ts'
import { DEFAULT_LIMITS } from '../../run-registry.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Gen, World } from '../../../kernel/index.ts'

const TERM_MEMBER = [{ kind: 'term', path: 'terms/' }]
const JOURNAL = 'state/world/journal.jsonl'

interface Version {
  world: World
  gen: Gen
}

function judgmentRouter(root: string) {
  return createRoundRouter({
    endpoints: new EndpointTable(),
    blobsDir: hostPaths(root).blobsDir,
    judgment: createJudgmentRunner(DEFAULT_LIMITS),
  })
}

/** 写入并 seed 同一身份的一个判定版本（服务无、判定住 `terms/probe.json`）。 */
function seedVersion(root: string, dir: string, value: number): Version {
  const pkg = writeTempPackage(root, {
    identity: 'j',
    dir,
    implements: ['j'],
    methods: { j: ['probe'] },
    judgments: { j: { probe: 'terms/probe.json' } },
    terms: { 'probe.json': JSON.stringify(['c', value]) },
    members: TERM_MEMBER,
  })
  expect(runSeed(root, [{ name: 'j', path: pkg }]).ok).toBe(true)
  const world = loadAnchor(join(root, JOURNAL)).world
  const state = world.ids['j']
  const gen = state.gens.find((candidate) => candidate.payload === state.active)
  expect(gen).toBeDefined()
  return { world, gen: gen as Gen }
}

function callProbe(root: string, world: World): Promise<unknown> {
  const routed = judgmentRouter(root).resolve(world, 'j', 'j', 'probe')
  if (!routed.ok) throw new Error(`resolve failed: ${routed.error}`)
  expect(routed.row.transport).toBe('term')
  expect(routed.row.pid).toBeUndefined()
  return routed.row.link.call('j', 'probe', null, 1000)
}

describe('判定热改：改判定 = 一条数据世代（不重启进程）', () => {
  it('仅 term 变化 → `data` 换代；路由用新判定；无进程；重放一致', async () => {
    const root = createTempRoot()
    try {
      const v1 = seedVersion(root, 'j-v1', 1)
      const v2 = seedVersion(root, 'j-v2', 2)

      // 换代判据：仅 term 成员内容变化 → data（进程热生效）；非 code（不起新服务）
      expect(
        classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, hostPaths(root).blobsDir),
      ).toBe('data')

      expect(await callProbe(root, v1.world)).toEqual({ ok: true, value: 1 })
      expect(await callProbe(root, v2.world)).toEqual({ ok: true, value: 2 })

      // 重放一致：同一下一代世界重读后判定不变
      const replayed = loadAnchor(join(root, JOURNAL)).world
      expect(await callProbe(root, replayed)).toEqual({ ok: true, value: 2 })
    } finally {
      await cleanupTempRoot(root)
    }
  })
})
