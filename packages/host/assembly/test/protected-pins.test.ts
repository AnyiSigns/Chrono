import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { planIngest } from '../index.ts'
import { runPack, runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { validatePackage } from '../../validate-package.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeChronoConfig, writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash, World } from '../../../kernel/index.ts'

const PROTECTED = ['sandbox', 'guard', 'secrets', 'approval', 'storage-sql', 'storage-kv']

describe('入世守卫：受保护 pins 不可删', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    writeChronoConfig(root, PROTECTED)
  })

  afterEach(() => cleanupTempRoot(root))

  it('跨代删掉对 sandbox 的 pins 引用 → 整批拒 protected_pin_removed', () => {
    const sandboxRoot = writeTempPackage(root, { identity: 'sandbox' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
    })
    const report = runSeed(root, [
      { name: 'sandbox', path: sandboxRoot },
      { name: 'tool-x', path: toolRoot },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

    // 同身份重写：删掉 sandbox 引用
    writeTempPackage(root, { identity: 'tool-x', pins: {} })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.reasons).toEqual(['protected_pin_removed'])
  })

  it('seed：跨代删掉对 storage-sql 的 pins 引用 → 整批拒 protected_pin_removed', () => {
    const storageRoot = writeTempPackage(root, { identity: 'storage-sql' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-store',
      pins: { storage: 'storage-sql' },
    })
    const report = runSeed(root, [
      { name: 'storage-sql', path: storageRoot },
      { name: 'tool-store', path: toolRoot },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

    writeTempPackage(root, { identity: 'tool-store', pins: {} })
    const planned = planIngest(world, root, { name: 'tool-store', path: toolRoot })
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.reasons).toEqual(['protected_pin_removed'])
  })

  it('pack：跨代删掉对 storage-kv 的 pins 引用 → 整批拒 protected_pin_removed', () => {
    const storageRoot = writeTempPackage(root, { identity: 'storage-kv' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-kv',
      pins: { storage: 'storage-kv' },
    })
    const seeded = runSeed(root, [
      { name: 'storage-kv', path: storageRoot },
      { name: 'tool-kv', path: toolRoot },
    ])
    expect(seeded.ok).toBe(true)

    writeTempPackage(root, { identity: 'tool-kv', pins: {} })
    const report = runPack(root, toolRoot, 'tool-kv')
    expect(report.ok).toBe(false)
    expect(report.status).toBe('failed')
    expect(report.reasons).toEqual(['protected_pin_removed'])
  })

  it('validate_package：候选包删存储 pins → 整批拒 protected_pin_removed', () => {
    const storageRoot = writeTempPackage(root, { identity: 'storage-sql' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-validate',
      pins: { storage: 'storage-sql' },
    })
    const seeded = runSeed(root, [
      { name: 'storage-sql', path: storageRoot },
      { name: 'tool-validate', path: toolRoot },
    ])
    expect(seeded.ok).toBe(true)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

    const pluginJson = {
      identity: 'tool-validate',
      schema: 'schema/plugin.schema.json',
      implements: [],
      methods: {},
      pins: {},
      start: '',
      protocol: '1',
      restart: { policy: 'never', backoff: 'none', max: 0, window_ms: 1, drain_ms: 1 },
      health: { interval_ms: 0, timeout_ms: 0 },
      state: 'recomputable',
      members: [],
      commands: [],
    }
    const files = (pins: Record<string, string>) => ({
      'plugin.json': JSON.stringify({ ...pluginJson, pins }),
      'schema/plugin.schema.json': JSON.stringify({ type: 'object' }),
      'package.json': JSON.stringify({ name: 'tool-validate', version: '0.0.0' }),
      'README.md': '# tool-validate\n',
    })
    const removed = validatePackage(
      world,
      hostPaths(root).runtimeDir,
      files({}),
      hostPaths(root).blobsDir,
      root,
    )
    expect(removed.accepted).toBe(true)
    if (removed.accepted) {
      expect(removed.report.ok).toBe(false)
      expect(removed.report.errors.map((error) => error.code)).toEqual(['protected_pin_removed'])
    }
    // 正对照：候选包保留存储 pins → 通过（证明旧声明可读、拒绝只因删了保护边）
    const kept = validatePackage(
      world,
      hostPaths(root).runtimeDir,
      files({ storage: 'storage-sql' }),
      hostPaths(root).blobsDir,
      root,
    )
    expect(kept.accepted).toBe(true)
    if (kept.accepted) expect(kept.report.ok).toBe(true)
  })

  it('保留受保护 pins 引用 → 允许换代', () => {
    const sandboxRoot = writeTempPackage(root, { identity: 'sandbox' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
    })
    runSeed(root, [
      { name: 'sandbox', path: sandboxRoot },
      { name: 'tool-x', path: toolRoot },
    ])
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

    // 改内容但保留 pins（加一个 term 改变源码树）
    writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
      terms: { 'x.json': JSON.stringify(['c', 'hello']) },
    })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(true)
  })

  it('非受保护身份的 pins 删除不受限', () => {
    const otherRoot = writeTempPackage(root, { identity: 'other-dep' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-x',
      pins: { other: 'other-dep' },
    })
    runSeed(root, [
      { name: 'other-dep', path: otherRoot },
      { name: 'tool-x', path: toolRoot },
    ])
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

    writeTempPackage(root, { identity: 'tool-x', pins: {} })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(true)
  })

  it('新身份（无旧世代）不触发受保护比对', () => {
    const toolRoot = writeTempPackage(root, { identity: 'tool-new', pins: {} })
    const planned = planIngest({ defs: {}, ids: {} }, root, { name: 'tool-new', path: toolRoot })
    expect(planned.ok).toBe(true)
  })

  it('retired 身份重入世删掉受保护 pin → 拒（不因 active=null 放行）', () => {
    const sandboxRoot = writeTempPackage(root, { identity: 'sandbox' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
    })
    const report = runSeed(root, [
      { name: 'sandbox', path: sandboxRoot },
      { name: 'tool-x', path: toolRoot },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    // 退役：active=null（旧代码世代仍在 gens 里）
    world.ids['tool-x'].active = null

    writeTempPackage(root, { identity: 'tool-x', pins: {} })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.reasons).toEqual(['protected_pin_removed'])
  })

  it('retired 身份重入世保留受保护 pin → 放行', () => {
    const sandboxRoot = writeTempPackage(root, { identity: 'sandbox' })
    const toolRoot = writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
    })
    runSeed(root, [
      { name: 'sandbox', path: sandboxRoot },
      { name: 'tool-x', path: toolRoot },
    ])
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    world.ids['tool-x'].active = null

    writeTempPackage(root, {
      identity: 'tool-x',
      pins: { sandbox: 'sandbox' },
      terms: { 'x.json': JSON.stringify(['c', 'hello']) },
    })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(true)
  })

  it('有代码世代但声明读不出 → fail-closed 拒 protected_pin_removed', () => {
    const codePayload: Hash = 'a'.repeat(64)
    const world: World = {
      defs: { [codePayload]: { body: { tree: 'missing-tree', meta: { name: 'tool-x' } } } },
      ids: {
        'tool-x': {
          id: 'tool-x',
          schema: 's'.repeat(64),
          gens: [
            {
              seq: 0,
              payload: codePayload,
              pins: {},
              sig: 's'.repeat(64),
              adopted: { at: 1, by: 'seed', write: 'w-1' },
            },
          ],
          active: codePayload,
          born: { at: 1, by: 'seed' },
        },
      },
    }
    const toolRoot = writeTempPackage(root, { identity: 'tool-x', pins: {} })
    const planned = planIngest(world, root, { name: 'tool-x', path: toolRoot })
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.reasons).toEqual(['protected_pin_removed'])
  })
})
