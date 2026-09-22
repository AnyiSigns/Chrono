// 物化回收的宿主接线：启动时（抢锁后、装配前）自动回收；离线 `runMaterializedGc` 同口径。
// 只覆盖「宿主侧触发点」，保留集 / 只删 64-hex 目录的算法细节在 assembly/test 单测。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runMaterializedGc, runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { materializeCommit } from '../assembly/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import type { Hash, World } from '../../kernel/index.ts'

describe('物化回收的宿主接线', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 兜底停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }

  /** 入世一个数据身份（无服务），返回其 active 代码世代。 */
  function seedDataOnly(): { world: World; active: Hash } {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-mat-boot',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', 1]) },
    })
    expect(runSeed(root, [{ name: 'toy-mat-boot', path: pkgRoot }]).ok).toBe(true)
    const world = loadAnchor(journalFile()).world
    return { world, active: world.ids['toy-mat-boot'].active as Hash }
  }

  it('runMaterializedGc：保留 active 世代目录，删除 64-hex 孤儿目录', () => {
    const { world, active } = seedDataOnly()
    const paths = hostPaths(root)
    expect(
      materializeCommit(world, active, paths.materializedDir, { blobsDir: paths.blobsDir }),
    ).not.toBeNull()
    const orphan = 'd'.repeat(64)
    mkdirSync(join(paths.materializedDir, orphan), { recursive: true })
    writeFileSync(join(paths.materializedDir, orphan, 'junk.txt'), 'x')

    const report = runMaterializedGc(root)
    expect(report.removed).toEqual([orphan])
    expect(report.kept).toBe(1)
    expect(existsSync(join(paths.materializedDir, orphan))).toBe(false)
    expect(existsSync(join(paths.materializedDir, active))).toBe(true)
  })

  it('宿主启动时回收物化目录：孤儿目录被删、保留集内目录保留', async () => {
    const { world, active } = seedDataOnly()
    const paths = hostPaths(root)
    expect(
      materializeCommit(world, active, paths.materializedDir, { blobsDir: paths.blobsDir }),
    ).not.toBeNull()
    const orphan = 'e'.repeat(64)
    mkdirSync(join(paths.materializedDir, orphan), { recursive: true })

    const handle = await startHost({ root })
    handles.push(handle)

    expect(existsSync(join(paths.materializedDir, orphan))).toBe(false)
    expect(existsSync(join(paths.materializedDir, active))).toBe(true)
  })
})
