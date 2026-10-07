// 项一：`boot pack` 的宿主侧纯命令面——与 seed 共用打包核心，整包一条原子 batch。
// 覆盖：新身份 / 已存在身份（只 add_gen）/ 坏包整批拒绝（世界分文未动）/ 与 seed 同哈希。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPack, runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

function worldOf(root: string): World {
  const paths = hostPaths(root)
  return loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).world
}

function commitTree(world: World, identity: string): { commit: Hash; tree: Hash } {
  const commit = world.ids[identity].active as Hash
  const tree = (world.defs[commit].body as { tree: Hash }).tree
  return { commit, tree }
}

describe('离线命令 pack（单目录入世）', () => {
  let root: string
  let pkgRoot: string

  beforeEach(() => {
    root = createTempRoot()
    pkgRoot = createToyPlugin(root)
  })

  afterEach(() => cleanupTempRoot(root))

  it('新身份：整包一条 batch，add_identity + add_gen，commit.meta 取自目录', () => {
    const report = runPack(root, pkgRoot, 'toy')
    expect(report.ok).toBe(true)
    expect(report.status).toBe('packed')
    expect(report.isNewIdentity).toBe(true)
    expect(report.identity).toBe('toy')

    const world = worldOf(root)
    expect(world.ids['toy']).toBeDefined()
    expect(world.ids['toy'].active).toBe(report.commitHash)
    const body = world.defs[report.commitHash as Hash].body as {
      meta?: { name?: string; version?: string }
    }
    expect(body.meta).toEqual({ name: 'toy', version: '0.0.0' })
  })

  it('已存在身份：只 add_gen，保留旧代码世代、不覆盖数据', () => {
    const first = runPack(root, pkgRoot, 'toy')
    expect(first.isNewIdentity).toBe(true)
    const firstGen = worldOf(root).ids['toy'].gens[0]

    // 改包内容 → 新代码世代（README 属源码树，哈希随内容变）
    writeFileSync(join(pkgRoot, 'README.md'), '# toy plugin v2\n')
    const second = runPack(root, pkgRoot, 'toy')
    expect(second.ok).toBe(true)
    expect(second.status).toBe('packed')
    expect(second.isNewIdentity).toBe(false)
    expect(second.commitHash).not.toBe(first.commitHash)

    const gens = worldOf(root).ids['toy'].gens
    expect(gens.length).toBe(2)
    expect(gens[0]).toEqual(firstGen)
    expect(worldOf(root).ids['toy'].active).toBe(second.commitHash)
  })

  it('同内容重复 pack：unchanged，不追加世代', () => {
    runPack(root, pkgRoot, 'toy')
    const report = runPack(root, pkgRoot, 'toy')
    expect(report.ok).toBe(true)
    expect(report.status).toBe('unchanged')
    expect(worldOf(root).ids['toy'].gens.length).toBe(1)
  })

  it('坏包整批拒绝：缺 plugin.json / 坏声明 / 缺 schema / 坏 .worldignore，世界分文未动', () => {
    const paths = hostPaths(root)
    const before = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).head

    // 缺 plugin.json
    const noPlugin = join(root, 'bad', 'noplugin')
    mkdirSync(noPlugin, { recursive: true })
    writeFileSync(join(noPlugin, 'package.json'), '{}')
    expect(runPack(root, noPlugin, 'noplugin').reasons).toEqual(['missing_plugin_json'])

    // 坏声明（字段不齐）
    const badDecl = join(root, 'bad', 'baddecl')
    mkdirSync(badDecl, { recursive: true })
    writeFileSync(join(badDecl, 'plugin.json'), JSON.stringify({ identity: 'baddecl' }))
    expect(runPack(root, badDecl, 'baddecl').reasons).toEqual(['bad_plugin_decl'])

    // 缺 schema（plugin.json 指向的文件不存在）
    const badSchema = writeTempPackage(root, { identity: 'badschema' })
    rmSync(join(badSchema, 'schema', 'plugin.schema.json'))
    expect(runPack(root, badSchema, 'badschema').reasons).toEqual(['missing_schema'])

    // 坏 .worldignore（含 .. 段）
    const badIgnore = writeTempPackage(root, { identity: 'badignore', worldignore: ['..'] })
    expect(runPack(root, badIgnore, 'badignore').reasons).toEqual(['bad_worldignore'])

    // 目录不存在
    expect(runPack(root, join(root, 'bad', 'absent'), 'absent').reasons).toEqual([
      'package_not_found',
    ])

    // 身份名与包内 plugin.json.identity 不一致
    expect(runPack(root, pkgRoot, 'other').reasons).toEqual(['identity_mismatch'])

    const after = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    expect(after.head).toEqual(before)
    expect(after.world.ids).toEqual({})
  })

  it('pack 与 seed 对同一目录产出相同 tree / commit 哈希（共用装箱逻辑）', async () => {
    const packRoot = createTempRoot()
    try {
      const seeded = runSeed(root, [{ name: 'toy', path: pkgRoot }])
      expect(seeded.ok).toBe(true)
      const fromSeed = commitTree(worldOf(root), 'toy')

      const packed = runPack(packRoot, pkgRoot, 'toy')
      expect(packed.ok).toBe(true)
      const fromPack = commitTree(worldOf(packRoot), 'toy')

      expect(fromPack.commit).toBe(fromSeed.commit)
      expect(fromPack.tree).toBe(fromSeed.tree)
    } finally {
      await cleanupTempRoot(packRoot)
    }
  })

  it('--identity 必须与包内 plugin.json.identity 一致：一致即入世，不一致即拒且世界分文未动', () => {
    // 不一致：identity_mismatch，不落任何世代
    const paths = hostPaths(root)
    const before = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).head
    const mismatch = runPack(root, pkgRoot, 'toy-alias')
    expect(mismatch.ok).toBe(false)
    expect(mismatch.reasons).toEqual(['identity_mismatch'])
    const after = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    expect(after.head).toEqual(before)
    expect(after.world.ids).toEqual({})

    // 一致：正常入世，meta.name = 包内身份
    const ok = runPack(root, pkgRoot, 'toy')
    expect(ok.ok).toBe(true)
    expect(ok.identity).toBe('toy')
    const world = worldOf(root)
    expect(world.ids['toy']).toBeDefined()
    const body = world.defs[ok.commitHash as Hash].body as { meta?: Json }
    expect(body.meta).toEqual({ name: 'toy', version: '0.0.0' })
  })
})
