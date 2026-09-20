import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { planIngest } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash, World } from '../../../kernel/index.ts'

describe('入世守卫：受保护 pins 不可删', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
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
