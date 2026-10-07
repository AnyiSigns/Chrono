// reloadPlugin 单测：内容未变不换代（不推进链头），内容变化才提交并交装配跟随。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorldWriter } from '../../writer.ts'
import { hostPaths } from '../../paths.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { reloadPlugin } from '../reload.ts'
import type { ReloadDeps } from '../reload.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Head, World } from '../../../kernel/index.ts'

describe('reloadPlugin（watcher 入世核心）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  function depsWith(writer: WorldWriter, applied: number[]): ReloadDeps {
    return {
      root,
      paths: hostPaths(root),
      writer,
      now: () => Date.now(),
      applyWorld: async (_world: World, head: Head): Promise<void> => {
        applied.push(head.seq)
      },
    }
  }

  it('内容未变 → unchanged：不推进链头、不交装配跟随', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-alpha',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: pkg }]).ok).toBe(true)
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const writer = new WorldWriter({ world: anchor.world, head: anchor.head })
    const applied: number[] = []
    const before = writer.snapshot().head.seq

    const outcome = await reloadPlugin(depsWith(writer, applied), {
      name: 'toy-alpha',
      path: pkg,
    })
    expect(outcome.status).toBe('unchanged')
    expect(writer.snapshot().head.seq).toBe(before)
    expect(applied).toEqual([])
  })

  it('内容变化 → committed：推进链头并交装配跟随', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-alpha',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: pkg }]).ok).toBe(true)
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const writer = new WorldWriter({ world: anchor.world, head: anchor.head })
    const applied: number[] = []
    const before = writer.snapshot().head.seq

    appendFileSync(join(pkg, 'execute', 'main.js'), '\n// v2\n')
    const outcome = await reloadPlugin(depsWith(writer, applied), {
      name: 'toy-alpha',
      path: pkg,
    })
    expect(outcome.status).toBe('committed')
    expect(writer.snapshot().head.seq).toBe(before + 1)
    expect(applied).toHaveLength(1)
  })
})
