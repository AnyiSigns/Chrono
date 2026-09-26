// 源码 CAS 存储层单测：put / get / 幂等 / 64-hex 校验 / 摘要校验；
// 以及 `validate_package` dry-run 不落 CAS 的边界。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BLOB_POINTER_KIND,
  blobFile,
  blobPointerOf,
  blobSha256,
  getBlob,
  isBlobPointer,
  putBlob,
} from '../blobs.ts'
import { validatePackage } from '../validate-package.ts'
import { runSeed } from '../offline.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import type { Json, World } from '../../kernel/index.ts'

const EMPTY_WORLD: World = { defs: {}, ids: {} }

describe('blobs CAS 存储层', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  function blobsDir(): string {
    return hostPaths(root).blobsDir
  }

  it('putBlob 返回 pointer（sha256 + size），getBlob 逐字节读回', () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x0a])
    const put = putBlob(blobsDir(), bytes)
    expect(put.ok).toBe(true)
    if (!put.ok) return
    expect(put.pointer.kind).toBe(BLOB_POINTER_KIND)
    expect(put.pointer.sha256).toBe(blobSha256(bytes))
    expect(put.pointer.size).toBe(bytes.length)

    const got = getBlob(blobsDir(), put.pointer)
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.bytes.equals(bytes)).toBe(true)
  })

  it('幂等：同内容二次 put 不新增文件、不改动既有字节', () => {
    const bytes = Buffer.from('same content')
    const first = putBlob(blobsDir(), bytes)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const file = join(blobsDir(), first.pointer.sha256)
    const before = readFileSync(file)
    const second = putBlob(blobsDir(), bytes)
    expect(second.ok).toBe(true)
    expect(readdirSync(blobsDir())).toEqual([blobSha256(bytes)])
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('缺失 → blob_missing；截断（size 不符）→ bad_blob', () => {
    const pointer = blobPointerOf(blobSha256(Buffer.from('abc')), 3)
    expect(getBlob(blobsDir(), pointer)).toEqual({ ok: false, code: 'blob_missing' })

    const put = putBlob(blobsDir(), Buffer.from('abcdef'))
    expect(put.ok).toBe(true)
    if (!put.ok) return
    writeFileSync(join(blobsDir(), put.pointer.sha256), Buffer.from('abc'))
    expect(getBlob(blobsDir(), put.pointer)).toEqual({ ok: false, code: 'bad_blob' })
  })

  it('blobFile / isBlobPointer 拒绝非 64-hex 与畸形形态（防路径穿越 / 误判）', () => {
    expect(blobFile(blobsDir(), '../escape')).toBeNull()
    expect(blobFile(blobsDir(), 'A'.repeat(64))).toBeNull()
    expect(blobFile(blobsDir(), 'a'.repeat(64))).not.toBeNull()

    expect(isBlobPointer(blobPointerOf('a'.repeat(64), 1))).toBe(true)
    expect(isBlobPointer({ kind: 'blob', sha256: 'short', size: 1 } as unknown as Json)).toBe(false)
    expect(isBlobPointer({ kind: 'blob', sha256: 'a'.repeat(64), size: -1 } as Json)).toBe(false)
    expect(isBlobPointer({ kind: 'asset', sha256: 'a'.repeat(64), size: 1 } as Json)).toBe(false)
    expect(isBlobPointer('inline text' as Json)).toBe(false)
    expect(isBlobPointer(null)).toBe(false)
  })
})

describe('validate_package dry-run 不写 CAS', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('候选包通过校验，但 state/blobs 不被创建（字节只在计划里）', () => {
    const candidate: Json = {
      'plugin.json': JSON.stringify({
        identity: 'candidate',
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
      'schema/plugin.schema.json': JSON.stringify({ type: 'object' }),
      'package.json': JSON.stringify({ name: 'candidate', version: '0.0.0' }),
    }
    const outcome = validatePackage(EMPTY_WORLD, hostPaths(root).runtimeDir, candidate)
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.report.ok).toBe(true)
    expect(existsSync(hostPaths(root).blobsDir)).toBe(false)
  })

  it('seed 落 CAS（正向对照）：字节出现在 state/blobs/<sha256>', () => {
    const pkgRoot = writeTempPackage(root, { identity: 'toy-cas', members: [] })
    const report = runSeed(root, [{ name: 'toy-cas', path: pkgRoot }])
    expect(report.ok).toBe(true)
    const files = readdirSync(hostPaths(root).blobsDir)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true)
    // 抽查一个：CAS 文件内容 = 其文件名对应的 sha256
    const sample = files[0]
    expect(blobSha256(readFileSync(join(hostPaths(root).blobsDir, sample)))).toBe(sample)
  })
})
