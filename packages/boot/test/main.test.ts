import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { runSeed, runVerify, runReplay } from '../../host/index.ts'
import { join } from 'node:path'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../../host/test/test-helpers.ts'

describe('CLI 薄壳 boot', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    createToyPlugin(root)
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]))
  })

  afterEach(() => cleanupTempRoot(root))

  it('seed 入世 toy 插件', () => {
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    const toy = report.items.find((i) => i.name === 'toy')
    expect(toy).toBeDefined()
    expect(toy!.status).toBe('seeded')
  })

  it('verify 校验通过', () => {
    runSeed(root)
    const report = runVerify(root)
    expect(report.ok).toBe(true)
    expect(report.head!.seq).toBeGreaterThanOrEqual(0)
  })

  it('replay 重建世界，worldRev 非空', () => {
    runSeed(root)
    const report = runReplay(root)
    expect(report.head.seq).toBeGreaterThanOrEqual(0)
    expect(typeof report.worldRev).toBe('string')
    expect(report.worldRev).toHaveLength(64)
  })
})
