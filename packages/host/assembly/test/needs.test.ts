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
  it('唯一提供方 → 写 commit.body.meta.needs，不写 gen.pins', async () => {
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
      // 绑定只住 meta，不进 pins（pins 不产生闭包 / 运行态边）
      expect(gen!.pins['title']).toBeUndefined()

      const planned = planIngest(world, root, { name: 'consumer', path: consumer })
      expect(planned.ok).toBe(true)
      if (planned.ok) {
        expect(planned.plan.needs).toEqual({ title: 'provider' })
        expect(planned.plan.pins).toEqual({})
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

  it('零扰动：无 needs 的包 meta 只有 name / version，pins 出口照实透传', async () => {
    const root = createTempRoot()
    try {
      const pkg = writeTempPackage(root, { identity: 'plain', pins: { host: 'host' } })
      const planned = planIngest({ defs: {}, ids: {} }, root, { name: 'plain', path: pkg })
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      expect(planned.plan.needs).toEqual({})
      expect(planned.plan.pins).toEqual({ host: 'host' })
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
})

describe('validate_package 报告：needs / pins 出口', () => {
  function consumerFiles(needs: Record<string, unknown>): Record<string, string> {
    return {
      'plugin.json': JSON.stringify({
        identity: 'consumer',
        implements: [],
        methods: {},
        pins: { host: 'host' },
        needs,
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

  it('通过：报告携带解析绑定与声明 pins', async () => {
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
        expect(outcome.report.needs).toEqual({ title: 'provider' })
        expect(outcome.report.pins).toEqual({ host: 'host' })
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('失败：报告 needs / pins 均为 null', async () => {
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
        expect(outcome.report.pins).toBeNull()
      }
    } finally {
      await cleanupTempRoot(root)
    }
  })
})
