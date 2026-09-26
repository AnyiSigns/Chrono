// 零 schema 入世：`plugin.json` 省略 `schema`（无世界数据的 UI 插件）时，宿主机械提供
// 最小默认 schema def；身份 `Identity.schema` 即该 def 哈希。pack / seed / validate_package 三路同口径。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { H } from '../../kernel/index.ts'
import { DEFAULT_SCHEMA_BODY } from '../assembly/index.ts'
import { runPack, runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { validatePackage } from '../validate-package.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import type { Json, World } from '../../kernel/index.ts'

/** 默认 schema def 的哈希口径 = `H({ body })`，与入世侧 `schemaHash` 同路。 */
const DEFAULT_SCHEMA_HASH = H({ body: DEFAULT_SCHEMA_BODY } as unknown as Json)

function worldOf(root: string): World {
  const paths = hostPaths(root)
  return loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).world
}

describe('零 schema 入世（省略 schema 字段）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('pack：省略 schema 入世成功，身份 schema = 默认 def 哈希且 def body 为最小体', () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'zero-schema',
      omitSchema: true,
      members: [],
    })
    const report = runPack(root, pkgRoot, 'zero-schema')
    expect(report.ok).toBe(true)
    expect(report.status).toBe('packed')

    const world = worldOf(root)
    expect(world.ids['zero-schema'].schema).toBe(DEFAULT_SCHEMA_HASH)
    expect(world.defs[DEFAULT_SCHEMA_HASH].body).toEqual({ type: 'object' })
  })

  it('seed：省略 schema 入世成功，身份 schema = 默认 def 哈希', () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'zero-schema-seed',
      omitSchema: true,
      members: [],
    })
    const report = runSeed(root, [{ name: 'zero-schema-seed', path: pkgRoot }])
    expect(report.ok).toBe(true)
    expect(report.items[0].status).toBe('seeded')
    expect(worldOf(root).ids['zero-schema-seed'].schema).toBe(DEFAULT_SCHEMA_HASH)
  })

  it('validate_package：候选包省略 schema → 通过并回 result_hash', () => {
    const outcome = validatePackage(worldOf(root), joinRuntime(root), {
      'plugin.json': JSON.stringify({
        identity: 'zero-schema-dry',
        implements: [],
        methods: {},
        pins: {},
        start: '',
        protocol: '1',
        restart: { policy: 'never' },
        health: {},
        state: 'recomputable',
        members: [],
        commands: [],
      }),
      'package.json': JSON.stringify({ name: 'zero-schema-dry', version: '0.0.0' }),
    })
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.report.ok).toBe(true)
    expect(outcome.report.errors).toEqual([])
    expect(outcome.report.result_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('schema 为空串：等同省略，validate_package 通过（空串合法）', () => {
    const outcome = validatePackage(worldOf(root), joinRuntime(root), {
      'plugin.json': JSON.stringify({
        identity: 'empty-schema-dry',
        schema: '',
        implements: [],
        methods: {},
        pins: {},
        start: '',
        protocol: '1',
        restart: { policy: 'never' },
        health: {},
        state: 'recomputable',
        members: [],
        commands: [],
      }),
      'package.json': JSON.stringify({ name: 'empty-schema-dry', version: '0.0.0' }),
    })
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.report.ok).toBe(true)
    expect(outcome.report.errors).toEqual([])
  })

  it('声明了 schema 但包内文件缺失：仍拒 missing_schema（既有门禁不变）', () => {
    const outcome = validatePackage(worldOf(root), joinRuntime(root), {
      'plugin.json': JSON.stringify({
        identity: 'declared-schema-missing',
        schema: 'schema/plugin.schema.json',
        implements: [],
        methods: {},
        pins: {},
        start: '',
        protocol: '1',
        restart: { policy: 'never' },
        health: {},
        state: 'recomputable',
        members: [],
        commands: [],
      }),
      'package.json': JSON.stringify({ name: 'declared-schema-missing', version: '0.0.0' }),
    })
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.report.ok).toBe(false)
    expect(outcome.report.errors.map((error) => error.code)).toContain('missing_schema')
  })
})

function joinRuntime(root: string): string {
  return hostPaths(root).runtimeDir
}
