// 生态 profile：解析优先级 / fail-closed / 默认零扰动，以及入世路径实际采纳覆盖（锁文件、通用排除）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ECOSYSTEM, readEcosystem } from '../ecosystem.ts'
import { planIngest } from '../ingest.ts'
import { packSourceDir } from '../source.ts'
import { capabilityProviders } from '../capability-index.ts'
import { readPluginDecl } from '../decl.ts'
import { resolveEcosystem } from '../../options.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { applyBatchOps, collectTreePaths, writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Json, World } from '../../../kernel/index.ts'

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function writeConfig(root: string, value: unknown): void {
  writeFileSync(join(root, 'chrono.config.json'), JSON.stringify(value))
}

describe('resolveEcosystem 解析（显式 > 环境 > 文件）', () => {
  it('三路都缺省 → declared:false、空覆盖（走内建默认）', () => {
    expect(resolveEcosystem()).toEqual({ ok: true, overrides: {}, declared: false })
  })

  it('文件部分覆盖：只回落提供的字段', () => {
    const result = resolveEcosystem(undefined, undefined, { lock_files: ['custom.lock'] })
    expect(result).toEqual({
      ok: true,
      overrides: { lockFiles: ['custom.lock'] },
      declared: true,
    })
  })

  it('显式覆盖环境与文件', () => {
    const result = resolveEcosystem({ sdk_package_name: 'sdk-a' }, '{"sdk_package_name":"sdk-b"}', {
      sdk_package_name: 'sdk-c',
    })
    expect(result).toEqual({ ok: true, overrides: { sdkPackageName: 'sdk-a' }, declared: true })
  })

  it('环境是 JSON 文本；坏 JSON → bad_ecosystem', () => {
    expect(resolveEcosystem(undefined, '{"sdk_package_name":"sdk-b"}')).toEqual({
      ok: true,
      overrides: { sdkPackageName: 'sdk-b' },
      declared: true,
    })
    expect(resolveEcosystem(undefined, 'not json')).toEqual({
      ok: false,
      reason: 'bad_ecosystem',
    })
  })

  it('形态非法 fail-closed：非对象 / 未知键 / 错型 / 空扩展名列表', () => {
    const badValues: Json[] = [
      1,
      ['x'],
      { unknown_key: ['x'] },
      { lock_files: 'package-lock.json' },
      { entry_extensions: [] },
      { npm_cache_env_var: 'bad name' },
      { source_excluded_names: [1] },
    ]
    for (const value of badValues) {
      expect(resolveEcosystem(undefined, undefined, value)).toEqual({
        ok: false,
        reason: 'bad_ecosystem',
      })
    }
  })
})

describe('readEcosystem 读取（仓库根 chrono.config.json）', () => {
  let root: string
  const priorEnv = process.env['CHRONO_ECOSYSTEM']

  beforeEach(() => {
    root = createTempRoot()
    delete process.env['CHRONO_ECOSYSTEM']
  })

  afterEach(async () => {
    if (priorEnv === undefined) delete process.env['CHRONO_ECOSYSTEM']
    else process.env['CHRONO_ECOSYSTEM'] = priorEnv
    await cleanupTempRoot(root)
  })

  it('配置文件缺失 / 键缺失 → 内建默认（逐字段等价）', () => {
    const empty = readEcosystem(root)
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.profile).toEqual(DEFAULT_ECOSYSTEM)

    writeConfig(root, { protected_pins: [] })
    const absent = readEcosystem(root)
    expect(absent.ok).toBe(true)
    if (absent.ok) expect(absent.profile).toEqual(DEFAULT_ECOSYSTEM)
  })

  it('部分覆盖叠到默认上，未给字段保持默认', () => {
    writeConfig(root, { ecosystem: { sdk_package_name: 'sdk-custom', entry_extensions: ['mjs'] } })
    const read = readEcosystem(root)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.profile.sdkPackageName).toBe('sdk-custom')
    expect(read.profile.entryExtensions).toEqual(['mjs'])
    expect(read.profile.lockFiles).toEqual(DEFAULT_ECOSYSTEM.lockFiles)
    expect(read.profile.sourceExcludedNames).toEqual(DEFAULT_ECOSYSTEM.sourceExcludedNames)
  })

  it('文件 JSON 坏 / 覆盖形态非法 → bad_ecosystem', () => {
    writeFileSync(join(root, 'chrono.config.json'), '{ broken')
    expect(readEcosystem(root)).toEqual({ ok: false, reason: 'bad_ecosystem' })

    writeConfig(root, { ecosystem: { unknown: true } })
    expect(readEcosystem(root)).toEqual({ ok: false, reason: 'bad_ecosystem' })
  })
})

describe('入世路径采纳生态覆盖', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('source_excluded_names 覆盖：自定义目录不进源码树', () => {
    writeConfig(root, {
      ecosystem: { source_excluded_names: ['node_modules', '.git', 'vendor'] },
    })
    const pkgRoot = writeTempPackage(root, {
      identity: 'eco-src',
      start: 'node execute/main.js',
      files: { 'vendor/secret.txt': 'secret', 'src/keep.js': 'keep' },
    })
    const profile = readEcosystem(root)
    expect(profile.ok).toBe(true)
    if (!profile.ok) return
    const packed = packSourceDir(pkgRoot, [], profile.profile.sourceExcludedNames)
    const world = emptyWorld()
    applyBatchOps(world, packed.ops)
    const paths = collectTreePaths(world, packed.rootTreeHash)
    expect(paths).not.toContain('vendor/secret.txt')
    expect(paths).toContain('src/keep.js')
  })

  it('lock_files 覆盖：自定义锁文件成为契约必需，被 worldignore 命中即拒', () => {
    writeConfig(root, { ecosystem: { lock_files: ['custom.lock'] } })
    const spec = {
      identity: 'eco-lock',
      start: 'node execute/main.js',
      worldignore: ['custom.lock'],
      files: { 'custom.lock': '{}' },
    }

    const pkgRoot = writeTempPackage(root, spec)
    const planned = planIngest(emptyWorld(), root, { name: 'eco-lock', path: pkgRoot })
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.reasons).toEqual(['bad_worldignore'])

    // 同包在无覆盖时不受保护：默认锁名单不含 custom.lock
    const defaultRoot = createTempRoot()
    try {
      const defaultPkg = writeTempPackage(defaultRoot, spec)
      const ok = planIngest(emptyWorld(), defaultRoot, { name: 'eco-lock', path: defaultPkg })
      expect(ok.ok).toBe(true)
    } finally {
      void cleanupTempRoot(defaultRoot)
    }
  })
})

describe('运行期声明解析采纳生态覆盖', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('readPluginDecl / 能力索引按注入 profile 解析 inproc 入口', () => {
    // 入世与运行期同源：配置覆盖后入世成功，运行期声明解析须用同一 profile 才能读回
    writeConfig(root, { ecosystem: { entry_extensions: ['custom'] } })
    const pkgRoot = writeTempPackage(root, {
      identity: 'eco-ext',
      implements: ['eco.ext'],
      methods: { 'eco.ext': ['echo'] },
      start: 'execute/main.custom',
      transport: 'inproc',
      files: { 'execute/main.custom': 'export const createService = () => ({} )\n' },
    })
    expect(runSeed(root, [{ name: 'eco-ext', path: pkgRoot }]).ok).toBe(true)
    const world: World = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const blobsDir = hostPaths(root).blobsDir
    const read = readEcosystem(root)
    expect(read.ok).toBe(true)
    if (!read.ok) return

    // 未注入 profile（内建默认）：入口扩展名不含 custom → 声明读不出（运行期回到旧行为）
    expect(readPluginDecl(world, 'eco-ext', blobsDir)).toBeNull()

    // 注入已解析 profile：同一世界同一世代解析成功，且与入世口径一致
    const resolved = readPluginDecl(world, 'eco-ext', blobsDir, read.profile)
    expect(resolved).not.toBeNull()
    expect(resolved?.decl.transport).toBe('inproc')

    // 能力索引同样按注入 profile 收录提供方
    expect(capabilityProviders(world, 'eco.ext', blobsDir)).toEqual([])
    expect(capabilityProviders(world, 'eco.ext', blobsDir, read.profile)).toEqual(['eco-ext'])
  })
})
