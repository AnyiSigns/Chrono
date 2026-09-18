import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeCommit } from '../materialize.ts'
import { MATERIALIZE_MARKER, packSourceDir } from '../source.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage, FIXTURE_ALPHA } from '../../test/test-helpers-ext.ts'
import { hostPaths } from '../../paths.ts'
import type { Hash, Json } from '../../../kernel/index.ts'

describe('物化 materializeCommit', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('写入全部文件（含嵌套目录），排除 .worldignore / test/，保留根级 test.js', () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-mat',
      worldignore: ['test/'],
      files: {
        'dist/bundle.js': 'bundle',
        'node_modules/dep/index.js': 'dep',
        '.git/config': '[core]',
        'test/spec.js': 'spec',
        'test.js': 'root test.js',
        'sub/inner/file.txt': 'inner',
      },
    })
    const report = runSeed(root, [{ name: 'toy-mat', path: pkgRoot }])
    expect(report.ok).toBe(true)

    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-mat'].active as Hash
    const matDir = hostPaths(root).materializedDir
    const rootDir = materializeCommit(world, commitHash, matDir)

    expect(rootDir).not.toBeNull()
    expect(existsSync(join(rootDir as string, 'plugin.json'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'package.json'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'README.md'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'schema', 'plugin.schema.json'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'dist', 'bundle.js'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'sub', 'inner', 'file.txt'))).toBe(true)
    expect(existsSync(join(rootDir as string, 'test.js'))).toBe(true)

    expect(existsSync(join(rootDir as string, '.worldignore'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'test', 'spec.js'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'test'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'node_modules', 'dep', 'index.js'))).toBe(false)
    expect(existsSync(join(rootDir as string, '.git', 'config'))).toBe(false)

    expect(readFileSync(join(rootDir as string, 'dist', 'bundle.js'), 'utf8')).toBe('bundle')
  })

  it('幂等：同 commit 二次调用返回同一根目录，内容一致', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const matDir = hostPaths(root).materializedDir

    const first = materializeCommit(world, commitHash, matDir)
    const second = materializeCommit(world, commitHash, matDir)
    expect(first).toBe(second)
    const mtime = statSync(join(first as string, 'execute', 'main.js')).mtimeMs
    expect(statSync(join(second as string, 'execute', 'main.js')).mtimeMs).toBe(mtime)
    expect(readFileSync(join(first as string, 'plugin.json'), 'utf8')).toBe(
      readFileSync(join(second as string, 'plugin.json'), 'utf8'),
    )
  })

  it('commit 缺失 → null，不抛错', () => {
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const matDir = hostPaths(root).materializedDir
    expect(materializeCommit(world, '0'.repeat(64) as Hash, matDir)).toBeNull()
    expect(existsSync(join(matDir, '0'.repeat(64)))).toBe(false)
  })

  it('二进制资产逐字节还原；pack→materialize→再 pack 根哈希一致（互逆）', () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-bytes',
      worldignore: ['test/'],
      files: {
        'dist/bundle.js': 'bundle',
        'src/keep.js': 'keep',
        'test/spec.js': 'spec',
      },
    })
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x0a, 0x0d, 0x7f])
    mkdirSync(join(pkgRoot, 'assets'), { recursive: true })
    writeFileSync(join(pkgRoot, 'assets', 'blob.bin'), binary)

    const report = runSeed(root, [{ name: 'toy-bytes', path: pkgRoot }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-bytes'].active as Hash
    const originalTree = (world.defs[commitHash] as { body: { tree: string } }).body.tree
    // 非 UTF-8 资产走 base64 blob 编码
    expect(Object.values(world.defs).some((def) => (def as { enc?: Json }).enc === 'base64')).toBe(
      true,
    )

    const rootDir = materializeCommit(world, commitHash, hostPaths(root).materializedDir)
    expect(rootDir).not.toBeNull()
    expect(readFileSync(join(rootDir as string, 'assets', 'blob.bin')).equals(binary)).toBe(true)

    // 互逆：物化树重新打包（标记文件恒排除）应得同一根 tree 哈希
    const repacked = packSourceDir(rootDir as string)
    expect(repacked.rootTreeHash).toBe(originalTree)
  })

  it('物化标记：缺标记/标记被篡改 → 整目录重物化（标记与内容恢复）', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const matDir = hostPaths(root).materializedDir

    const first = materializeCommit(world, commitHash, matDir) as string
    expect(first).not.toBeNull()
    expect(readFileSync(join(first, MATERIALIZE_MARKER), 'utf8').trim()).toBe(commitHash)

    // 标记被篡改 + 源码被改动：目录不可信，整目录重物化
    writeFileSync(join(first, MATERIALIZE_MARKER), 'deadbeef')
    writeFileSync(join(first, 'plugin.json'), '{"tampered":true}')
    const second = materializeCommit(world, commitHash, matDir)
    expect(second).toBe(first)
    expect(readFileSync(join(second as string, MATERIALIZE_MARKER), 'utf8').trim()).toBe(commitHash)
    expect(JSON.parse(readFileSync(join(second as string, 'plugin.json'), 'utf8'))).toMatchObject({
      identity: 'toy-alpha',
    })

    // 标记缺失同样触发重物化
    rmSync(join(second as string, MATERIALIZE_MARKER))
    const third = materializeCommit(world, commitHash, matDir)
    expect(third).toBe(first)
    expect(existsSync(join(third as string, MATERIALIZE_MARKER))).toBe(true)
  })
})
