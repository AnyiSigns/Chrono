// S5 换代判据单测（A6 机械口径）：按 members 跨代比对「路径 + 解析内容」→ data / code。
// 不按目录名硬编码；声明不可读 / 成员路径增删 / 同路径两用都以 execute 优先。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { classifyGenerationChange, readPluginDeclOfGen } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { hostPaths } from '../../paths.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { PackageSpec } from '../../test/test-helpers-ext.ts'
import type { Gen, World } from '../../../kernel/index.ts'

const BOTH_MEMBERS = [
  { kind: 'execute', path: 'execute/' },
  { kind: 'term', path: 'terms/' },
]

interface Version {
  world: World
  gen: Gen
}

describe('classifyGenerationChange（A6 换代判据）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  /** 源码 CAS 目录：世代声明是 pointer blob，读文本须经它。 */
  const blobsDir = (): string => hostPaths(root).blobsDir

  /** 依序写入并 seed 同一身份的多个版本；返回每个版本 seed 后的世界与该世代。 */
  function seedVersions(identity: string, specs: Omit<PackageSpec, 'identity'>[]): Version[] {
    const versions: Version[] = []
    specs.forEach((spec, index) => {
      const pkg = writeTempPackage(root, { identity, dir: `${identity}-v${index}`, ...spec })
      const report = runSeed(root, [{ name: identity, path: pkg }])
      expect(report.ok).toBe(true)
      expect(report.items[0].status).toBe('seeded')
      const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
      const identityState = world.ids[identity]
      const gen = identityState.gens.find((g) => g.payload === identityState.active)
      expect(gen).toBeDefined()
      versions.push({ world, gen: gen as Gen })
    })
    return versions
  }

  it('仅 term 成员内容变化 → data（进程热生效）', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { members: BOTH_MEMBERS, terms: { 'a.json': JSON.stringify(['c', 1]) } },
      { members: BOTH_MEMBERS, terms: { 'a.json': JSON.stringify(['c', 2]) } },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('data')
  })

  it('execute 成员内容变化 → code（起新服务）', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { start: 'node execute/main.js' },
      { start: 'node execute/main.js', files: { 'execute/extra.js': '// v2\n' } },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('code')
  })

  it('execute 与 term 同时变化 → code（execute 优先）', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { start: 'node execute/main.js', members: BOTH_MEMBERS, terms: { 'a.json': '["c",1]' } },
      {
        start: 'node execute/main.js',
        members: BOTH_MEMBERS,
        terms: { 'a.json': '["c",2]' },
        files: { 'execute/extra.js': '// v2\n' },
      },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('code')
  })

  it('execute 成员路径删除 → code', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { start: 'node execute/main.js', members: BOTH_MEMBERS, terms: { 'a.json': '["c",1]' } },
      { members: [{ kind: 'term', path: 'terms/' }], terms: { 'a.json': '["c",1]' } },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('code')
  })

  it('term 成员路径新增 → data', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { members: [{ kind: 'term', path: 'terms/' }], terms: { 'a.json': '["c",1]' } },
      {
        members: [
          { kind: 'term', path: 'terms/' },
          { kind: 'schema', path: 'schema/' },
        ],
        terms: { 'a.json': '["c",1]' },
      },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('data')
  })

  it('成员内容都不变（仅非成员字段变化）→ data：进程不动', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { start: 'node execute/main.js', members: BOTH_MEMBERS, terms: { 'a.json': '["c",1]' } },
      {
        start: 'node execute/main.js',
        members: BOTH_MEMBERS,
        terms: { 'a.json': '["c",1]' },
        health: { interval_ms: 1234, timeout_ms: 99 },
      },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('data')
  })

  it('同路径被 execute 与 term 两用：内容变化 → code（execute 优先）', () => {
    const dual = [
      { kind: 'term', path: 'terms/' },
      { kind: 'execute', path: 'terms/' },
    ]
    const [v1, v2] = seedVersions('toy-gen', [
      { start: 'node execute/main.js', members: dual, terms: { 'a.json': '["c",1]' } },
      { start: 'node execute/main.js', members: dual, terms: { 'a.json': '["c",2]' } },
    ])
    expect(classifyGenerationChange(v1.world, v1.gen, v2.world, v2.gen, blobsDir())).toBe('code')
  })

  it('声明不可读（世代 payload 缺 def）→ code（保守起新服务）', () => {
    const [v1] = seedVersions('toy-gen', [{ start: 'node execute/main.js' }])
    const broken: Gen = {
      seq: 9,
      payload: 'f'.repeat(64),
      pins: {},
      sig: 'f'.repeat(64),
      adopted: { at: 0, by: '', write: '' },
    }
    expect(classifyGenerationChange(v1.world, broken, v1.world, v1.gen, blobsDir())).toBe('code')
    expect(classifyGenerationChange(v1.world, v1.gen, v1.world, broken, blobsDir())).toBe('code')
  })

  it('readPluginDeclOfGen 按指定世代读声明（非 active 也能读）', () => {
    const [v1, v2] = seedVersions('toy-gen', [
      { members: BOTH_MEMBERS, terms: { 'a.json': '["c",1]' } },
      { members: BOTH_MEMBERS, terms: { 'a.json': '["c",2]' } },
    ])
    expect(v2.world.ids['toy-gen'].active).toBe(v2.gen.payload)
    const readOld = readPluginDeclOfGen(v2.world, v1.gen, blobsDir())
    expect(readOld).not.toBeNull()
    expect(readOld!.decl.identity).toBe('toy-gen')
    expect(readOld!.gen.payload).toBe(v1.gen.payload)
  })
})
