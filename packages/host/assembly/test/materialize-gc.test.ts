// 物化目录回收单测：保留集 = active 代码世代 + 前 N 代；只删 64-hex 目录；
// 关键正确性——回收后 set_active 指回被删世代仍能由「指针 def + CAS 字节」重新物化。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gcMaterialized, materializeCommit, materializedKeepSet } from '../materialize.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor, replayFull } from '../../ledger/index.ts'
import { commit } from '../../../kernel/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash } from '../../../kernel/index.ts'

describe('物化回收（materialized gc）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }

  /** 同一身份入世一版：版本号进 package.json，terms 内容随版本变，产出不同的 commit。 */
  function seedVersion(dir: string, version: string): void {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-mat-gc',
      dir,
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', version]) },
      packageJson: { name: 'toy-mat-gc', version, private: true },
    })
    expect(runSeed(root, [{ name: 'toy-mat-gc', path: pkgRoot }]).ok).toBe(true)
  }

  function world(): ReturnType<typeof loadAnchor>['world'] {
    return loadAnchor(journalFile()).world
  }

  function materializeAll(gens: Hash[]): string {
    const dir = hostPaths(root).materializedDir
    for (const gen of gens) {
      const result = materializeCommit(world(), gen, dir, { blobsDir: hostPaths(root).blobsDir })
      expect(result).not.toBeNull()
    }
    return dir
  }

  it('保留集：active 代码世代 + 前 N 代，其余目录删除', () => {
    for (const version of ['1', '2', '3', '4']) seedVersion(`toy-mat-gc-v${version}`, version)
    const current = world()
    const gens = current.ids['toy-mat-gc'].gens.map((gen) => gen.payload)
    expect(gens).toHaveLength(4)

    const matDir = materializeAll(gens)
    expect(readdirSync(matDir).sort()).toEqual([...gens].sort())

    // 默认 N=5：4 代全在保留集内
    expect([...materializedKeepSet(current)].sort()).toEqual([...gens].sort())

    // N=1：只留 active + 前 1 代
    const report = gcMaterialized(matDir, current, 1)
    expect(report.scanned).toBe(4)
    expect(report.kept).toBe(2)
    expect(report.removed).toEqual([gens[0], gens[1]].sort())
    expect(report.failed).toEqual([])
    expect(existsSync(join(matDir, gens[0]))).toBe(false)
    expect(existsSync(join(matDir, gens[1]))).toBe(false)
    expect(existsSync(join(matDir, gens[2]))).toBe(true)
    expect(existsSync(join(matDir, gens[3]))).toBe(true)
  })

  it('只删 64-hex 目录：staging 目录、非目录项与意外内容不碰', () => {
    seedVersion('toy-mat-gc-v1', '1')
    const current = world()
    const gen = current.ids['toy-mat-gc'].active as Hash
    const matDir = materializeAll([gen])

    const staging = join(matDir, `${gen}.tmp-123-456`)
    mkdirSync(staging, { recursive: true })
    mkdirSync(join(matDir, 'notes'), { recursive: true })
    const strayFile = join(matDir, 'f'.repeat(64))
    writeFileSync(strayFile, 'stray file')

    const report = gcMaterialized(matDir, current, 0)
    expect(report.scanned).toBe(1)
    expect(report.kept).toBe(1)
    expect(report.removed).toEqual([])
    expect(existsSync(staging)).toBe(true)
    expect(existsSync(join(matDir, 'notes'))).toBe(true)
    expect(existsSync(strayFile)).toBe(true)
    expect(existsSync(join(matDir, gen))).toBe(true)
  })

  it('回收后 set_active 指回被删世代仍能重新物化（指针 def + CAS 字节重建）', () => {
    seedVersion('toy-mat-gc-v1', '1')
    seedVersion('toy-mat-gc-v2', '2')
    const anchor = loadAnchor(journalFile())
    const gens = anchor.world.ids['toy-mat-gc'].gens.map((gen) => gen.payload)
    const oldGen = gens[0]
    const activeGen = gens[1]
    expect(anchor.world.ids['toy-mat-gc'].active).toBe(activeGen)

    const paths = hostPaths(root)
    expect(
      materializeCommit(anchor.world, oldGen, paths.materializedDir, { blobsDir: paths.blobsDir }),
    ).not.toBeNull()

    // 只保留 active（N=0）→ 回滚目标的物化目录被回收
    const report = gcMaterialized(paths.materializedDir, anchor.world, 0)
    expect(report.removed).toEqual([oldGen])
    expect(existsSync(join(paths.materializedDir, oldGen))).toBe(false)

    // set_active 指回被回收的世代：内核一次追加，世界仍持有其 commit / tree / 指针 def
    const outcome = commit(
      anchor.head,
      anchor.world,
      {
        id: 'rollback',
        op: 'set_active',
        target: { expect_pos: anchor.head.hash },
        args: { id: 'toy-mat-gc', active: oldGen },
        by: 'test',
      },
      Date.now(),
    )
    expect(outcome.verdict.ok).toBe(true)
    if (outcome.entry === null) throw new Error('rollback not recorded')
    const rolled = replayFull([...anchor.entries, outcome.entry])
    expect(rolled.ids['toy-mat-gc'].active).toBe(oldGen)

    // 重新物化成功：字节从 CAS 重建，不依赖被回收的目录
    const rebuilt = materializeCommit(rolled, oldGen, paths.materializedDir, {
      blobsDir: paths.blobsDir,
    })
    expect(rebuilt).not.toBeNull()
    expect(JSON.parse(readFileSync(join(rebuilt as string, 'terms', 'x.json'), 'utf8'))).toEqual([
      'c',
      '1',
    ])
  })
})
