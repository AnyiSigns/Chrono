import { describe, expect, it } from 'vitest'
import { latestCodeGen, needsBindingsOf, orderEntriesForSeed, planIngest } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { validatePackage } from '../../validate-package.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'

const JOURNAL = (root: string) => `${root}/state/world/journal.jsonl`

describe('能力需求 needs：one 入世解析', () => {
  it('唯一提供方 → 写 commit.body.meta.needs，不进内核世代存储', async () => {
    const root = createTempRoot()
    try {
      const provider = writeTempPackage(root, {
        identity: 'provider',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { title: { mode: 'one' } },
      })
      const report = runSeed(root, [
        { name: 'provider', path: provider },
        { name: 'consumer', path: consumer },
      ])
      expect(report.ok).toBe(true)
      const world = loadAnchor(JOURNAL(root)).world
      const gen = latestCodeGen(world, 'consumer')
      expect(gen).not.toBeNull()
      expect(needsBindingsOf(world, gen!)).toEqual({ title: 'provider' })
      // 内核世代只留 seq / payload / sig；依赖只住 commit.body.meta.needs
      expect(Object.hasOwn(gen as object, 'pins')).toBe(false)

      const planned = planIngest(world, root, { name: 'consumer', path: consumer })
      expect(planned.ok).toBe(true)
      if (planned.ok) {
        expect(planned.plan.needs).toEqual({ title: 'provider' })
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('无提供方 → 拒 unresolved_need', async () => {
    const root = createTempRoot()
    try {
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { title: { mode: 'one' } },
      })
      const report = runSeed(root, [{ name: 'consumer', path: consumer }])
      expect(report.ok).toBe(false)
      expect(report.items[0].reasons).toEqual(['unresolved_need:title'])
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('多提供方 → 拒 ambiguous_need，候选码元序并列', async () => {
    const root = createTempRoot()
    try {
      const b = writeTempPackage(root, { identity: 'b-prov', implements: ['title'] })
      const a = writeTempPackage(root, { identity: 'a-prov', implements: ['title'] })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { title: { mode: 'one' } },
      })
      const report = runSeed(root, [
        { name: 'b-prov', path: b },
        { name: 'a-prov', path: a },
        { name: 'consumer', path: consumer },
      ])
      expect(report.ok).toBe(false)
      expect(report.items[2].reasons).toEqual(['ambiguous_need:title:a-prov,b-prov'])
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('换提供方：退役旧 + 世界出现新提供方 → 新 commitHash 且绑定更新', async () => {
    const root = createTempRoot()
    try {
      const oldProvider = writeTempPackage(root, {
        identity: 'old-prov',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { title: { mode: 'one' } },
      })
      expect(
        runSeed(root, [
          { name: 'old-prov', path: oldProvider },
          { name: 'consumer', path: consumer },
        ]).ok,
      ).toBe(true)
      const newProvider = writeTempPackage(root, {
        identity: 'new-prov',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      expect(runSeed(root, [{ name: 'new-prov', path: newProvider }]).ok).toBe(true)

      const world = loadAnchor(JOURNAL(root)).world
      const before = latestCodeGen(world, 'consumer')!.payload
      world.ids['old-prov'].active = null

      const planned = planIngest(world, root, { name: 'consumer', path: consumer })
      expect(planned.ok).toBe(true)
      if (planned.ok) {
        expect(planned.plan.needs).toEqual({ title: 'new-prov' })
        expect(planned.plan.commitHash).not.toBe(before)
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('零扰动：无 needs 的包 meta 只有 name / version，不带 needs 字段', async () => {
    const root = createTempRoot()
    try {
      const pkg = writeTempPackage(root, { identity: 'plain' })
      const planned = planIngest({ defs: {}, ids: {} }, root, { name: 'plain', path: pkg })
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      expect(planned.plan.needs).toEqual({})
      const commit = planned.plan.ops.find(
        (op) => (op as { args?: { body?: { meta?: unknown } } }).args?.body?.meta !== undefined,
      ) as { args?: { body?: { meta?: Record<string, unknown> } } } | undefined
      const meta = commit?.args?.body?.meta
      expect(meta).toBeDefined()
      expect(Object.hasOwn(meta as object, 'needs')).toBe(false)
    } finally {
      await cleanupTempRoot(root)
    }
  })
})

describe('能力需求 needs：seed 排序', () => {
  it('消费方在清单中先于提供方，仍按 one-need 排序提供方先入世', () => {
    const root = createTempRoot()
    try {
      const provider = writeTempPackage(root, {
        identity: 'provider',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { title: { mode: 'one' } },
      })
      const ordered = orderEntriesForSeed(root, [
        { name: 'consumer', path: consumer },
        { name: 'provider', path: provider },
      ])
      expect(ordered.map((entry) => entry.name)).toEqual(['provider', 'consumer'])
      expect(
        runSeed(root, [
          { name: 'consumer', path: consumer },
          { name: 'provider', path: provider },
        ]).ok,
      ).toBe(true)
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('无自带方法的 many 需求：拥有方在清单中后列，仍排序拥有方先入世', () => {
    const root = createTempRoot()
    try {
      const owner = writeTempPackage(root, {
        identity: 'owner',
        slots: { hook: { methods: ['onTurn'] } },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { hook: { mode: 'many' } },
      })
      const ordered = orderEntriesForSeed(root, [
        { name: 'consumer', path: consumer },
        { name: 'owner', path: owner },
      ])
      expect(ordered.map((entry) => entry.name)).toEqual(['owner', 'consumer'])
      expect(
        runSeed(root, [
          { name: 'consumer', path: consumer },
          { name: 'owner', path: owner },
        ]).ok,
      ).toBe(true)
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('many 自带 methods 不依赖拥有方：无拥有方也可入世', async () => {
    const root = createTempRoot()
    try {
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { hook: { mode: 'many', methods: ['onTurn'] } },
      })
      expect(runSeed(root, [{ name: 'consumer', path: consumer }]).ok).toBe(true)
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('无自带方法且无拥有方契约 → 拒 bad_plugin_decl', async () => {
    const root = createTempRoot()
    try {
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        needs: { hook: { mode: 'many' } },
      })
      const report = runSeed(root, [{ name: 'consumer', path: consumer }])
      expect(report.ok).toBe(false)
      expect(report.items[0].reasons).toEqual(['bad_plugin_decl'])
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('无自带方法的 many 与拥有方互为依赖（成环）：契约随同批补齐，seed 仍成功', async () => {
    const root = createTempRoot()
    try {
      const owner = writeTempPackage(root, {
        identity: 'owner',
        slots: { hook: { methods: ['onTurn'] } },
        needs: { runner: { mode: 'one' } },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        implements: ['runner'],
        methods: { runner: ['run'] },
        needs: { hook: { mode: 'many' } },
      })
      const entries = [
        { name: 'owner', path: owner },
        { name: 'consumer', path: consumer },
      ]
      // 硬依赖 owner needs runner → consumer 决定拓扑序；成环的 many 契约边被放弃。
      expect(orderEntriesForSeed(root, entries).map((entry) => entry.name)).toEqual([
        'consumer',
        'owner',
      ])
      expect(runSeed(root, entries).ok).toBe(true)
    } finally {
      await cleanupTempRoot(root)
    }
  })
})

describe('能力需求 needs：one 选择跳过休眠提供方', () => {
  function seedProviders(root: string, ids: string[]): void {
    const entries = ids.map((id) => {
      const path = writeTempPackage(root, {
        identity: id,
        implements: ['title'],
        methods: { title: ['get'] },
      })
      return { name: id, path }
    })
    expect(runSeed(root, entries).ok).toBe(true)
  }

  function consumerAt(root: string): string {
    return writeTempPackage(root, {
      identity: 'consumer',
      needs: { title: { mode: 'one' } },
    })
  }

  it('非休眠候选优先：休眠者被跳过，绑到非休眠提供方', () => {
    const root = createTempRoot()
    try {
      seedProviders(root, ['a-prov', 'b-prov'])
      const consumer = consumerAt(root)
      const world = loadAnchor(JOURNAL(root)).world
      const planned = planIngest(
        world,
        root,
        { name: 'consumer', path: consumer },
        new Set(['a-prov']),
      )
      expect(planned.ok).toBe(true)
      if (planned.ok) expect(planned.plan.needs).toEqual({ title: 'b-prov' })
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('非休眠为空 → 回落到休眠者绑定（消费方仍入世，调用得 not_loaded）', () => {
    const root = createTempRoot()
    try {
      seedProviders(root, ['only-prov'])
      const consumer = consumerAt(root)
      const world = loadAnchor(JOURNAL(root)).world
      const planned = planIngest(
        world,
        root,
        { name: 'consumer', path: consumer },
        new Set(['only-prov']),
      )
      expect(planned.ok).toBe(true)
      if (planned.ok) expect(planned.plan.needs).toEqual({ title: 'only-prov' })
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('过滤后 ≥2（非休眠）→ ambiguous_need，候选不含休眠者', () => {
    const root = createTempRoot()
    try {
      seedProviders(root, ['a-prov', 'b-prov', 'c-prov'])
      const consumer = consumerAt(root)
      const world = loadAnchor(JOURNAL(root)).world
      const planned = planIngest(
        world,
        root,
        { name: 'consumer', path: consumer },
        new Set(['a-prov']),
      )
      expect(planned.ok).toBe(false)
      if (!planned.ok) expect(planned.reasons).toEqual(['ambiguous_need:title:b-prov,c-prov'])
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('非休眠为空而休眠 ≥2 → ambiguous_need，候选为休眠者', () => {
    const root = createTempRoot()
    try {
      seedProviders(root, ['a-prov', 'b-prov'])
      const consumer = consumerAt(root)
      const world = loadAnchor(JOURNAL(root)).world
      const planned = planIngest(
        world,
        root,
        { name: 'consumer', path: consumer },
        new Set(['a-prov', 'b-prov']),
      )
      expect(planned.ok).toBe(false)
      if (!planned.ok) expect(planned.reasons).toEqual(['ambiguous_need:title:a-prov,b-prov'])
    } finally {
      cleanupTempRoot(root)
    }
  })
})

describe('validate_package 报告：needs 出口', () => {
  function consumerFiles(needs: Record<string, unknown>): Record<string, string> {
    return {
      'plugin.json': JSON.stringify({
        identity: 'consumer',
        implements: [],
        methods: {},
        needs: { ...needs, host: { mode: 'one' } },
        start: '',
        build: [],
        protocol: '1',
        restart: {},
        health: {},
        state: 'recomputable',
        members: [],
        commands: [],
      }),
      'package.json': JSON.stringify({ name: 'consumer', version: '0.0.0' }),
      'README.md': '# consumer\n',
    }
  }

  it('通过：报告携带解析绑定', async () => {
    const root = createTempRoot()
    try {
      const provider = writeTempPackage(root, {
        identity: 'provider',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      expect(runSeed(root, [{ name: 'provider', path: provider }]).ok).toBe(true)
      const world = loadAnchor(JOURNAL(root)).world
      const outcome = validatePackage(
        world,
        hostPaths(root).runtimeDir,
        consumerFiles({ title: { mode: 'one' } }),
        hostPaths(root).blobsDir,
        root,
      )
      expect(outcome.accepted).toBe(true)
      if (outcome.accepted) {
        expect(outcome.report.ok).toBe(true)
        expect(outcome.report.needs).toEqual({ host: 'host', title: 'provider' })
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('失败：报告 needs 为 null', async () => {
    const root = createTempRoot()
    try {
      const outcome = validatePackage(
        { defs: {}, ids: {} },
        hostPaths(root).runtimeDir,
        consumerFiles({ title: { mode: 'one' } }),
        hostPaths(root).blobsDir,
        root,
      )
      expect(outcome.accepted).toBe(true)
      if (outcome.accepted) {
        expect(outcome.report.ok).toBe(false)
        expect(outcome.report.needs).toBeNull()
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })
})
