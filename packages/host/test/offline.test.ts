import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { runSeed, runVerify, runReplay, readPluginManifest } from '../offline.ts'
import { join } from 'node:path'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../test/test-helpers.ts'
import { writeTempPackage } from '../test/test-helpers-ext.ts'

describe('离线命令', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    createToyPlugin(root)
    const { writeFileSync } = require('node:fs')
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]),
    )
  })

  afterEach(() => cleanupTempRoot(root))

  it('runSeed 入世 toy 插件，items 含 seeded', () => {
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    const toy = report.items.find((i) => i.name === 'toy')
    expect(toy).toBeDefined()
    expect(toy!.status).toBe('seeded')
    expect(toy!.identity).toBe('toy')
  })

  it('runVerify 通过校验', () => {
    runSeed(root)
    const report = runVerify(root)
    expect(report.ok).toBe(true)
    expect(report.head).not.toBeUndefined()
    expect(report.head!.seq).toBeGreaterThanOrEqual(0)
  })

  it('runReplay 重建世界，worldRev 非空', () => {
    runSeed(root)
    const report = runReplay(root)
    expect(report.head.seq).toBeGreaterThanOrEqual(0)
    expect(typeof report.worldRev).toBe('string')
    expect(report.worldRev.length).toBe(64)
  })

  it('runSeed 重复入世同一插件 → unchanged', () => {
    runSeed(root)
    const report = runSeed(root)
    const toy = report.items.find((i) => i.name === 'toy')
    expect(toy!.status).toBe('unchanged')
  })

  it('runSeed 按 pins 名级排序：依赖者先登记也一次入世', () => {
    const depRoot = writeTempPackage(root, { identity: 'dep', omitSchema: true, start: '' })
    const consumerRoot = writeTempPackage(root, {
      identity: 'consumer',
      omitSchema: true,
      start: '',
      pins: { dep: 'dep' },
    })
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'consumer', path: consumerRoot },
        { name: 'dep', path: depRoot },
      ]),
    )
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    expect(report.items.find((i) => i.name === 'dep')!.status).toBe('seeded')
    expect(report.items.find((i) => i.name === 'consumer')!.status).toBe('seeded')
  })

  it('readPluginManifest 缺文件返回空数组', async () => {
    const emptyRoot = createTempRoot()
    expect(readPluginManifest(emptyRoot)).toEqual([])
    await cleanupTempRoot(emptyRoot)
  })
})
