// 有效 pins 助手：声明 `pins` ∪ 当前代码世代 `one`-needs 绑定（同名键声明 pins 优先）、`many` 不并入、无代码世代 → null。

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { effectivePins, latestCodeGen } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Json } from '../../../kernel/index.ts'

const JOURNAL = (root: string) => join(root, 'state', 'world', 'journal.jsonl')

describe('有效 pins：effectivePins', () => {
  it('并集：声明 pins ∪ one-needs，many 不并入', async () => {
    const root = createTempRoot()
    try {
      const provider = writeTempPackage(root, {
        identity: 'provider',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      const owner = writeTempPackage(root, {
        identity: 'owner',
        slots: { hook: { methods: ['onTurn'] } },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        pins: { host: 'host' },
        needs: { title: { mode: 'one' }, hook: { mode: 'many' } },
      })
      expect(
        runSeed(root, [
          { name: 'provider', path: provider },
          { name: 'owner', path: owner },
          { name: 'consumer', path: consumer },
        ]).ok,
      ).toBe(true)
      const world = loadAnchor(JOURNAL(root)).world
      expect(effectivePins(world, 'consumer', hostPaths(root).blobsDir)).toEqual({
        host: 'host',
        title: 'provider',
      })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('同名键：声明 pins 优先，one 绑定不覆盖', async () => {
    const root = createTempRoot()
    try {
      const provider = writeTempPackage(root, {
        identity: 'provider',
        implements: ['title'],
        methods: { title: ['get'] },
      })
      const consumer = writeTempPackage(root, {
        identity: 'consumer',
        pins: { host: 'host' },
        needs: { title: { mode: 'one' } },
      })
      expect(
        runSeed(root, [
          { name: 'provider', path: provider },
          { name: 'consumer', path: consumer },
        ]).ok,
      ).toBe(true)
      const world = loadAnchor(JOURNAL(root)).world
      const gen = latestCodeGen(world, 'consumer')
      expect(gen).not.toBeNull()
      const body = world.defs[gen!.payload].body as { meta: { needs: Record<string, Json> } }
      body.meta.needs['host'] = 'other'
      expect(effectivePins(world, 'consumer', hostPaths(root).blobsDir)).toEqual({
        host: 'host',
        title: 'provider',
      })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('无代码世代 → null', () => {
    expect(effectivePins({ defs: {}, ids: {} }, 'nobody')).toBeNull()
  })
})
