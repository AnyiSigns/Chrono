import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeCommit } from '../materialize.ts'
import type { BlobLinker } from '../materialize.ts'
import { MATERIALIZE_MARKER, packSourceDir } from '../source.ts'
import { runSeed, runPack } from '../../offline.ts'
import { appendJournal, loadAnchor } from '../../ledger/index.ts'
import { blobSha256, isBlobPointer } from '../../blobs.ts'
import { readPluginDecl, resolveTreeEntry } from '../decl.ts'
import { commit, EMPTY_HEAD, H } from '../../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage, FIXTURE_ALPHA } from '../../test/test-helpers-ext.ts'
import { hostPaths } from '../../paths.ts'
import type { BlobPointer } from '../../blobs.ts'
import type { Hash, Head, Json, World } from '../../../kernel/index.ts'

/** 取 tree 内某文件的 pointer def；非 pointer（inline 旧形态）返回 null。 */
function pointerAt(world: World, treeHash: Hash, relPath: string): BlobPointer | null {
  const entry = resolveTreeEntry(world, treeHash, relPath)
  if (entry === null || entry.mode !== 'file') return null
  const body = world.defs[entry.hash]?.body
  return isBlobPointer(body) ? body : null
}

function treeOfCommit(world: World, commitHash: Hash): Hash {
  return (world.defs[commitHash] as { body: { tree: Hash } }).body.tree
}

/**
 * 造一个 inline（旧形态）journal 并 replay：blob def body 为字符串，字节在链上。
 * 用于验证旧世界不迁移即可读取与物化。
 */
function seedInlineJournal(root: string): Hash {
  const pluginJson = JSON.stringify({
    identity: 'toy-inline',
    implements: [],
    methods: {},
    pins: {},
    start: '',
    protocol: '1',
    restart: {},
    health: {},
    state: 'recomputable',
    members: [],
    commands: [],
  })
  const ops: Json[] = [
    { op: 'put', args: { body: pluginJson } },
    {
      op: 'put',
      args: { body: { entries: [{ name: 'plugin.json', mode: 'file', hash: { $n: 0 } }] } },
    },
    {
      op: 'put',
      args: { body: { tree: { $n: 1 }, meta: { name: 'toy-inline', version: '' } } },
    },
    { op: 'put', args: { body: { type: 'object' } } },
    { op: 'add_identity', args: { id: 'toy-inline', schema: { $n: 3 } } },
    { op: 'add_gen', args: { id: 'toy-inline', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} } },
  ]
  const world: World = { defs: {}, ids: {} }
  const head: Head = { ...EMPTY_HEAD }
  const outcome = commit(
    head,
    world,
    {
      id: 'inline-seed',
      op: 'batch',
      target: { expect_pos: null },
      args: { ops },
      by: 'test',
    },
    1,
  )
  if (!outcome.verdict.ok || outcome.entry === null) {
    throw new Error(`inline seed rejected: ${outcome.verdict.reasons.join(',')}`)
  }
  const journalFile = join(root, 'state', 'world', 'journal.jsonl')
  appendJournal(journalFile, [outcome.entry])
  // 经真实 replay 还原世界：旧形态必须能读
  const anchor = loadAnchor(journalFile)
  return anchor.world.ids['toy-inline'].active as Hash
}

describe('物化 materializeCommit', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  function paths(): ReturnType<typeof hostPaths> {
    return hostPaths(root)
  }

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
    const matDir = paths().materializedDir
    const rootDir = materializeCommit(world, commitHash, matDir, { blobsDir: paths().blobsDir })

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
    const matDir = paths().materializedDir
    const options = { blobsDir: paths().blobsDir }

    const first = materializeCommit(world, commitHash, matDir, options)
    const second = materializeCommit(world, commitHash, matDir, options)
    expect(first).toBe(second)
    const mtime = statSync(join(first as string, 'execute', 'main.js')).mtimeMs
    expect(statSync(join(second as string, 'execute', 'main.js')).mtimeMs).toBe(mtime)
    expect(readFileSync(join(first as string, 'plugin.json'), 'utf8')).toBe(
      readFileSync(join(second as string, 'plugin.json'), 'utf8'),
    )
  })

  it('commit 缺失 → null，不抛错', () => {
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const matDir = paths().materializedDir
    expect(materializeCommit(world, '0'.repeat(64) as Hash, matDir)).toBeNull()
    expect(existsSync(join(matDir, '0'.repeat(64)))).toBe(false)
  })

  it('pointer 物化：文本按 CAS 还原；二进制逐字节还原且不再走 base64（pack→materialize→再 pack 互逆）', () => {
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
    const originalTree = treeOfCommit(world, commitHash)

    // 二进制资产与文本同形：都是 pointer def，CAS 存原始字节，链上无 base64
    const binaryPointer = pointerAt(world, originalTree, 'assets/blob.bin')
    expect(binaryPointer).not.toBeNull()
    expect(binaryPointer!.sha256).toBe(blobSha256(binary))
    expect(binaryPointer!.size).toBe(binary.length)
    expect(readFileSync(join(paths().blobsDir, binaryPointer!.sha256)).equals(binary)).toBe(true)
    const textPointer = pointerAt(world, originalTree, 'dist/bundle.js')
    expect(textPointer!.sha256).toBe(blobSha256(Buffer.from('bundle', 'utf8')))
    // 旧形态的 base64 enc 已不复存在
    expect(Object.values(world.defs).some((def) => (def as { enc?: Json }).enc === 'base64')).toBe(
      false,
    )

    const rootDir = materializeCommit(world, commitHash, paths().materializedDir, {
      blobsDir: paths().blobsDir,
    })
    expect(rootDir).not.toBeNull()
    expect(readFileSync(join(rootDir as string, 'assets', 'blob.bin')).equals(binary)).toBe(true)
    expect(readFileSync(join(rootDir as string, 'dist', 'bundle.js'), 'utf8')).toBe('bundle')

    // 互逆：物化树重新打包（标记文件恒排除）应得同一根 tree 哈希
    const repacked = packSourceDir(rootDir as string)
    expect(repacked.rootTreeHash).toBe(originalTree)
  })

  it('pointer 物化走硬链接：同卷下 nlink >= 2（CAS 与工作副本共享 inode）', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const tree = treeOfCommit(world, commitHash)
    const rootDir = materializeCommit(world, commitHash, paths().materializedDir, {
      blobsDir: paths().blobsDir,
    }) as string

    const pointer = pointerAt(world, tree, 'plugin.json') as BlobPointer
    const dest = join(rootDir, 'plugin.json')
    const casFile = join(paths().blobsDir, pointer.sha256)
    expect(statSync(dest).nlink).toBeGreaterThanOrEqual(2)
    // 同一 inode：改一个链接的元数据（这里只读置位）两侧一致
    expect(statSync(dest).mode & 0o222).toBe(0)
    expect(statSync(casFile).mode & 0o222).toBe(0)
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(casFile, 'utf8'))
  })

  it('硬链接不支持（注入 EXDEV）→ 回退复制：nlink 1 且内容一致', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const failLink: BlobLinker = () => {
      const err = new Error('cross-device link') as NodeJS.ErrnoException
      err.code = 'EXDEV'
      throw err
    }
    const rootDir = materializeCommit(world, commitHash, paths().materializedDir, {
      blobsDir: paths().blobsDir,
      linker: failLink,
    }) as string
    const dest = join(rootDir, 'plugin.json')
    expect(existsSync(dest)).toBe(true)
    expect(statSync(dest).nlink).toBe(1)
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toMatchObject({ identity: 'toy-alpha' })
  })

  it('源码文件置只读：就地覆写失败（POSIX 0444 / Windows 清写位）', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const rootDir = materializeCommit(world, commitHash, paths().materializedDir, {
      blobsDir: paths().blobsDir,
    }) as string
    expect(() => writeFileSync(join(rootDir, 'plugin.json'), 'mutated')).toThrow()
    // 内容未被污染
    expect(JSON.parse(readFileSync(join(rootDir, 'plugin.json'), 'utf8'))).toMatchObject({
      identity: 'toy-alpha',
    })
  })

  it('CAS 缺失 → blob_missing（不产出半棵树）', () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as Hash
    const emptyCas = join(root, 'state', 'empty-blobs')
    mkdirSync(emptyCas, { recursive: true })
    const matDir = paths().materializedDir
    expect(() =>
      materializeCommit(world, commitHash, matDir, { blobsDir: emptyCas }),
    ).toThrow('blob_missing')
    expect(existsSync(join(matDir, commitHash))).toBe(false)
  })

  it('inline 旧 journal replay + 物化成功（旧世界不迁移直接跑）', () => {
    const commitHash = seedInlineJournal(root)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    // 旧形态 def body 仍是字符串，未被 pointer 化
    const tree = treeOfCommit(world, commitHash)
    expect(pointerAt(world, tree, 'plugin.json')).toBeNull()
    // 不传 blobsDir 也能物化：inline 分支不依赖 CAS
    const rootDir = materializeCommit(world, commitHash, paths().materializedDir)
    expect(rootDir).not.toBeNull()
    expect(JSON.parse(readFileSync(join(rootDir as string, 'plugin.json'), 'utf8'))).toMatchObject({
      identity: 'toy-inline',
    })
  })

  it('混合世界：inline 旧世代与 pointer 新世代共存，声明读取与物化各走各的形态', () => {
    // 先造 inline 旧世代（模拟既有世界），再入世一个 pointer 新世代（升级后的新写入）
    const inlineCommit = seedInlineJournal(root)
    const mixedPkg = writeTempPackage(root, { identity: 'toy-mixed', members: [] })
    expect(runPack(root, mixedPkg, 'toy-mixed').ok).toBe(true)

    const journalFile = join(root, 'state', 'world', 'journal.jsonl')
    const world = loadAnchor(journalFile).world
    const mixedCommit = world.ids['toy-mixed'].active as Hash

    // 声明读取：inline 旧世代不需要 CAS；pointer 新世代缺 blobsDir 时 fail-closed（不猜内容）
    expect(readPluginDecl(world, 'toy-inline')?.decl.identity).toBe('toy-inline')
    expect(readPluginDecl(world, 'toy-mixed')).toBeNull()
    expect(readPluginDecl(world, 'toy-mixed', paths().blobsDir)?.decl.identity).toBe('toy-mixed')

    // 物化：inline 分支不依赖 CAS；pointer 分支经 CAS
    const matDir = paths().materializedDir
    const inlineDir = materializeCommit(world, inlineCommit, matDir) as string
    expect(JSON.parse(readFileSync(join(inlineDir, 'plugin.json'), 'utf8'))).toMatchObject({
      identity: 'toy-inline',
    })
    const mixedDir = materializeCommit(world, mixedCommit, matDir, {
      blobsDir: paths().blobsDir,
    }) as string
    expect(JSON.parse(readFileSync(join(mixedDir, 'plugin.json'), 'utf8'))).toMatchObject({
      identity: 'toy-mixed',
    })
    expect(pointerAt(world, treeOfCommit(world, mixedCommit), 'plugin.json')).not.toBeNull()
    expect(pointerAt(world, treeOfCommit(world, inlineCommit), 'plugin.json')).toBeNull()
  })

  it('物化标记：缺标记/标记被篡改 → 整目录重物化（标记与内容恢复）', () => {
    // 用 inline 世界：源码是可写副本，篡改不会经硬链接污染 CAS
    const commitHash = seedInlineJournal(root)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const matDir = paths().materializedDir

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
      identity: 'toy-inline',
    })

    // 标记缺失同样触发重物化
    rmSync(join(second as string, MATERIALIZE_MARKER))
    const third = materializeCommit(world, commitHash, matDir)
    expect(third).toBe(first)
    expect(existsSync(join(third as string, MATERIALIZE_MARKER))).toBe(true)
  })
})
