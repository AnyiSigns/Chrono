// 插件目录发现：扫 `plugins` 下各子目录的 `plugin.json`；`state/plugins.json` 降级为可选覆盖
// （路径覆盖 / `node_modules` 解析 / 显式排除）。坏目录跳过并记运维日志，不 fail-stop。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSeed, runPack } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { readLifecycle, writeDiscoveredPackage, writeTempPackage } from './test-helpers-ext.ts'

function writeManifest(root: string, entries: unknown): void {
  const file = hostPaths(root).pluginsFile
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(file, JSON.stringify(entries))
}

function worldIds(root: string): string[] {
  const world = loadAnchor(hostPaths(root).journalFile).world
  return Object.keys(world.ids).sort()
}

describe('插件目录发现 + 清单可选覆盖', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('无 plugins.json：目录发现直接入世', () => {
    writeDiscoveredPackage(root, { identity: 'toy-a' })
    writeDiscoveredPackage(root, { identity: 'toy-b' })
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    expect(worldIds(root)).toEqual(['toy-a', 'toy-b'])
  })

  it('清单项覆盖同名目录（清单 path 优先）', () => {
    writeDiscoveredPackage(root, { identity: 'toy-a' })
    writeTempPackage(root, { identity: 'toy-b' })
    writeManifest(root, [{ name: 'toy-a', path: 'pkgs/toy-b' }])
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    // 同名目录被清单覆盖：真实身份取覆盖包内的 plugin.json.identity
    expect(worldIds(root)).toEqual(['toy-b'])
  })

  it('清单排除项从并集移除（目录发现不加载）', () => {
    writeDiscoveredPackage(root, { identity: 'toy-a' })
    writeDiscoveredPackage(root, { identity: 'toy-keep' })
    writeManifest(root, [{ name: 'toy-a', exclude: true }])
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    expect(worldIds(root)).toEqual(['toy-keep'])
  })

  it('模板包在 plugins/ 之外，目录发现不加载它', () => {
    writeDiscoveredPackage(root, { identity: 'toy-a' })
    // templates/plugin 与 plugins/ 同级但不在扫描面内
    writeTempPackage(root, { identity: 'tpl', dir: '../templates/plugin' })
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    expect(worldIds(root)).toEqual(['toy-a'])
  })

  it('plugin.json 读不出的目录跳过并记运维日志，不 fail-stop', () => {
    writeDiscoveredPackage(root, { identity: 'toy-ok' })
    const broken = join(root, 'plugins', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'plugin.json'), '{ not json')
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    expect(worldIds(root)).toEqual(['toy-ok'])
    const log = readLifecycle(hostPaths(root).lifecycleFile)
    expect(log.some((entry) => entry.event === 'plugin_discovery_skipped')).toBe(true)
  })

  it('pack 的 --identity 与包内 identity 不一致 → identity_mismatch', () => {
    const pkgRoot = writeDiscoveredPackage(root, { identity: 'toy-a' })
    const report = runPack(root, pkgRoot, 'other')
    expect(report.ok).toBe(false)
    expect(report.reasons).toEqual(['identity_mismatch'])
  })
})
