// 投递目录大资产直拷（`assets_manifest`）：从投递包源目录复制被 `.worldignore` 排除的大资产到
// 物化目录、按 sha256 校验；源文件缺失 / 大小或哈希不符 → 服务启动失败 `deps_failed`；
// 声明非法只记运维日志、不阻断装载。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyAssetsManifest, readAssetsManifest } from '../assets-manifest.ts'
import { resolvePluginSourceRoot } from '../ingest.ts'
import { ServiceStartError } from '../supervision.ts'
import { runSeed } from '../../offline.ts'
import { startHost } from '../../host.ts'
import type { HostHandle } from '../../host.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { readLifecycle, waitForLifecycle, writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash, Json, World } from '../../../kernel/index.ts'

const ASSET_BYTES = Buffer.from('chrono-asset-bytes-0123456789')
const ASSET_SHA = createHash('sha256').update(ASSET_BYTES).digest('hex')

/** 最小世界桩：只有一个身份，schema def body 即给定 schema。 */
function worldWithSchema(schema: Json): World {
  return {
    defs: { ['s'.repeat(64)]: { body: schema } },
    ids: {
      'toy-a': {
        id: 'toy-a',
        schema: 's'.repeat(64) as Hash,
        gens: [],
        active: null,
        born: { at: 1, by: 'test' },
      },
    },
  }
}

describe('assets_manifest 读取 readAssetsManifest', () => {
  it('无声明 / 非对象 schema → 空表', () => {
    expect(readAssetsManifest(worldWithSchema({ type: 'object' }), 'toy-a')).toEqual({
      ok: true,
      entries: [],
    })
    expect(readAssetsManifest({ defs: {}, ids: {} }, 'ghost')).toEqual({ ok: true, entries: [] })
  })

  it('合法清单 → 逐项读出', () => {
    const manifest = readAssetsManifest(
      worldWithSchema({
        assets_manifest: [
          { path: 'assets/model.bin', sha256: ASSET_SHA, size: ASSET_BYTES.length },
        ],
      }),
      'toy-a',
    )
    expect(manifest).toEqual({
      ok: true,
      entries: [{ path: 'assets/model.bin', sha256: ASSET_SHA, size: ASSET_BYTES.length }],
    })
  })

  it('声明非法（非数组 / 缺字段 / 坏 sha / 逃逸路径）→ ok:false，不抛', () => {
    const cases: Json[] = [
      { assets_manifest: {} },
      { assets_manifest: [{ path: 'a', sha256: ASSET_SHA }] },
      { assets_manifest: [{ path: 'a', sha256: 'nope', size: 1 }] },
      { assets_manifest: [{ path: '../escape', sha256: ASSET_SHA, size: 1 }] },
      { assets_manifest: [{ path: '/abs', sha256: ASSET_SHA, size: 1 }] },
    ]
    for (const schema of cases) {
      expect(readAssetsManifest(worldWithSchema(schema), 'toy-a')).toEqual({
        ok: false,
        reason: 'assets_manifest_invalid',
      })
    }
  })
})

describe('assets_manifest 直拷 copyAssetsManifest', () => {
  let root: string
  let source: string
  let target: string

  beforeEach(() => {
    root = createTempRoot()
    source = join(root, 'source')
    target = join(root, 'target')
    mkdirSync(join(source, 'assets'), { recursive: true })
    writeFileSync(join(source, 'assets', 'model.bin'), ASSET_BYTES)
  })

  afterEach(() => cleanupTempRoot(root))

  it('直拷成功：文件逐字节落到物化目录', () => {
    copyAssetsManifest(
      [{ path: 'assets/model.bin', sha256: ASSET_SHA, size: ASSET_BYTES.length }],
      source,
      target,
    )
    expect(readFileSync(join(target, 'assets', 'model.bin')).equals(ASSET_BYTES)).toBe(true)
  })

  it('哈希不符 → ServiceStartError(deps_failed)', () => {
    expect(() =>
      copyAssetsManifest(
        [{ path: 'assets/model.bin', sha256: '0'.repeat(64), size: ASSET_BYTES.length }],
        source,
        target,
      ),
    ).toThrowError(ServiceStartError)
    try {
      copyAssetsManifest(
        [{ path: 'assets/model.bin', sha256: '0'.repeat(64), size: ASSET_BYTES.length }],
        source,
        target,
      )
    } catch (err) {
      expect((err as ServiceStartError).reason).toBe('deps_failed')
    }
  })

  it('大小不符 / 源文件缺失 → ServiceStartError(deps_failed)', () => {
    expect(() =>
      copyAssetsManifest(
        [{ path: 'assets/model.bin', sha256: ASSET_SHA, size: ASSET_BYTES.length + 1 }],
        source,
        target,
      ),
    ).toThrowError(ServiceStartError)
    expect(() =>
      copyAssetsManifest(
        [{ path: 'assets/missing.bin', sha256: ASSET_SHA, size: 1 }],
        source,
        target,
      ),
    ).toThrowError(ServiceStartError)
  })
})

describe('投递包源目录解析 resolvePluginSourceRoot', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('清单登记的身份 → 返回包根；未登记 / 缺清单 → null', () => {
    const pkgRoot = writeTempPackage(root, { identity: 'toy-src', start: '' })
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy-src', path: pkgRoot }]),
    )
    expect(resolvePluginSourceRoot(root, 'toy-src')).toBe(pkgRoot)
    expect(resolvePluginSourceRoot(root, 'ghost')).toBeNull()
  })

  it('缺 state/plugins.json → null（不抛）', () => {
    expect(resolvePluginSourceRoot(root, 'toy-src')).toBeNull()
  })
})

describe('assets_manifest 接入宿主启动', () => {
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

  /** 写一个声明 assets_manifest 的服务包 + `state/plugins.json` 一行，seed 入世。 */
  function seedAssetsPackage(manifest: Json): string {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-assets',
      implements: ['toy.assets'],
      methods: { 'toy.assets': ['echo'] },
      start: 'node execute/main.js',
      worldignore: ['assets/'],
      schema: { type: 'object', assets_manifest: manifest },
    })
    // 被 `.worldignore` 排除的资产只存在于投递包源目录：直接按字节写盘
    mkdirSync(join(pkgRoot, 'assets'), { recursive: true })
    writeFileSync(join(pkgRoot, 'assets', 'model.bin'), ASSET_BYTES)
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy-assets', path: pkgRoot }]),
    )
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    return pkgRoot
  }

  it('直拷成功：物化目录出现被排除的资产字节', async () => {
    seedAssetsPackage([{ path: 'assets/model.bin', sha256: ASSET_SHA, size: ASSET_BYTES.length }])
    const world = loadAnchor(journalFile()).world
    const commit = world.ids['toy-assets'].active as Hash
    const handle = await startHost({ root })
    handles.push(handle)
    const materialized = join(hostPaths(root).materializedDir, commit, 'assets', 'model.bin')
    expect(existsSync(materialized)).toBe(true)
    expect(readFileSync(materialized).equals(ASSET_BYTES)).toBe(true)
  })

  it('哈希不符 → 服务启动失败 deps_failed（分支隔离，宿主照常起）', async () => {
    seedAssetsPackage([
      { path: 'assets/model.bin', sha256: '0'.repeat(64), size: ASSET_BYTES.length },
    ])
    const handle = await startHost({ root })
    handles.push(handle)
    const records = await waitForLifecycle(
      join(root, 'state', 'lifecycle.log'),
      (entry) =>
        entry.kind === 'service' &&
        entry.event === 'start_failed' &&
        entry.reason === 'deps_failed',
      'deps_failed log',
    )
    expect(records.some((entry) => entry.impl === 'toy-assets')).toBe(true)
  })

  it('清单路径缺失 → 服务启动失败 deps_failed', async () => {
    seedAssetsPackage([{ path: 'assets/missing.bin', sha256: ASSET_SHA, size: 1 }])
    const handle = await startHost({ root })
    handles.push(handle)
    const records = await waitForLifecycle(
      join(root, 'state', 'lifecycle.log'),
      (entry) =>
        entry.kind === 'service' &&
        entry.event === 'start_failed' &&
        entry.reason === 'deps_failed',
      'missing asset deps_failed',
    )
    expect(records.some((entry) => entry.impl === 'toy-assets')).toBe(true)
  })

  it('声明非法只记运维日志、不阻断装载', async () => {
    seedAssetsPackage({ bogus: true })
    const handle = await startHost({ root })
    handles.push(handle)
    const records = await waitForLifecycle(
      join(root, 'state', 'lifecycle.log'),
      (entry) =>
        entry.kind === 'dep' &&
        entry.event === 'periodic_invalid' &&
        entry.reason === 'assets_manifest_invalid',
      'assets_manifest_invalid log',
    )
    expect(records.some((entry) => entry.impl === 'toy-assets')).toBe(true)
    // 服务照常装载（无 deps_failed）
    expect(
      readLifecycle(join(root, 'state', 'lifecycle.log')).some(
        (entry) => entry.impl === 'toy-assets' && entry.reason === 'deps_failed',
      ),
    ).toBe(false)
  })
})
