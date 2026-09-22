// 入世打包的 pointer 形态单测：packSourceDir 产 pointer def 并按内容去重；
// pointer def 作为普通 Json body 被内核按 `dup` 幂等短路；同包二次入世报 unchanged。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packSourceDir } from '../source.ts'
import { resolveTreeEntry } from '../decl.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { blobSha256, isBlobPointer } from '../../blobs.ts'
import { commit, EMPTY_HEAD, H } from '../../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { applyBatchOps, writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { BlobPointer } from '../../blobs.ts'
import type { Hash, Json, World } from '../../../kernel/index.ts'

/** 取一批 ops 里的 pointer def（目录 tree def 的 body 不是 pointer，自然过滤掉）。 */
function pointerOps(ops: Json[]): BlobPointer[] {
  const out: BlobPointer[] = []
  for (const op of ops) {
    const body = (op as { args?: { body?: Json } }).args?.body
    if (isBlobPointer(body)) out.push(body)
  }
  return out
}

describe('packSourceDir 产 pointer def', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('每个文件产 pointer def（kind/sha256/size），文本与二进制同形，不再 base64', () => {
    const pkgRoot = join(root, 'pkg')
    mkdirSync(join(pkgRoot, 'sub'), { recursive: true })
    const binary = Buffer.from([0x00, 0xff, 0x01, 0x80])
    writeFileSync(join(pkgRoot, 'a.txt'), 'same')
    writeFileSync(join(pkgRoot, 'b.txt'), 'same')
    writeFileSync(join(pkgRoot, 'sub', 'bin.dat'), binary)

    const packed = packSourceDir(pkgRoot)
    const pointers = pointerOps(packed.ops)
    // a.txt / b.txt 同内容 → 同一 pointer def 出现两次（内核按 def 键去重）
    expect(pointers).toHaveLength(3)
    expect(pointers.every((pointer) => pointer.kind === 'blob')).toBe(true)
    const samePointer = pointers.find((pointer) => pointer.sha256 === blobSha256(Buffer.from('same')))
    expect(samePointer).toBeDefined()
    expect(samePointer!.size).toBe(4)
    const binPointer = pointers.find((pointer) => pointer.sha256 === blobSha256(binary))
    expect(binPointer).toBeDefined()
    expect(binPointer!.size).toBe(binary.length)
    // 无 base64 形态：所有 def body 都是 pointer 或 tree
    expect(packed.ops.every((op) => !Object.hasOwn(op as object, 'enc'))).toBe(true)

    // 待落 CAS 字节按 sha256 去重：distinct 内容数 = 2
    expect(packed.blobs.map((blob) => blob.sha256).sort()).toEqual(
      [blobSha256(Buffer.from('same')), blobSha256(binary)].sort(),
    )
    expect(packed.blobs.find((blob) => blob.sha256 === blobSha256(binary))!.bytes.equals(binary)).toBe(
      true,
    )
  })

  it('同内容文件解析到同一 blob def 键（tree 结构共享）', () => {
    const pkgRoot = join(root, 'pkg')
    mkdirSync(pkgRoot, { recursive: true })
    writeFileSync(join(pkgRoot, 'a.txt'), 'same')
    writeFileSync(join(pkgRoot, 'b.txt'), 'same')
    const packed = packSourceDir(pkgRoot)
    const world: World = { defs: {}, ids: {} }
    applyBatchOps(world, packed.ops)
    const a = resolveTreeEntry(world, packed.rootTreeHash as Hash, 'a.txt')
    const b = resolveTreeEntry(world, packed.rootTreeHash as Hash, 'b.txt')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.hash).toBe(b!.hash)
  })
})

describe('pointer def 命中内核 dup 短路', () => {
  it('同 pointer def 两次 put：第二次 reasons 含 dup、不产生新 entry', () => {
    const pointer = { body: { kind: 'blob', sha256: 'a'.repeat(64), size: 3 } }
    const world: World = { defs: {}, ids: {} }
    const first = commit(
      { ...EMPTY_HEAD },
      world,
      {
        id: 'p1',
        op: 'put',
        target: { expect_pos: null },
        args: pointer as unknown as Json,
        by: 'test',
      },
      1,
    )
    expect(first.verdict.ok).toBe(true)
    expect(first.entry).not.toBeNull()
    const head = { seq: first.entry!.seq, hash: first.hash as Hash }
    const second = commit(
      head,
      world,
      {
        id: 'p2',
        op: 'put',
        target: { expect_pos: head.hash },
        args: pointer as unknown as Json,
        by: 'test',
      },
      2,
    )
    expect(second.verdict.reasons).toContain('dup')
    expect(second.entry).toBeNull()
    // pointer def 键 = H(def)，与 sha256 不同（tree 仍引用 def 键）
    expect(H(pointer as unknown as Json)).not.toBe('a'.repeat(64))
  })
})

describe('同内容两次入世', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('同一包二次 seed → unchanged（不新增世代、不新增 entry）', () => {
    const pkgRoot = writeTempPackage(root, { identity: 'toy-dup', members: [] })
    const first = runSeed(root, [{ name: 'toy-dup', path: pkgRoot }])
    expect(first.items[0].status).toBe('seeded')
    const journal = join(root, 'state', 'world', 'journal.jsonl')
    const headAfterFirst = loadAnchor(journal).head

    const second = runSeed(root, [{ name: 'toy-dup', path: pkgRoot }])
    expect(second.items[0].status).toBe('unchanged')
    expect(loadAnchor(journal).head).toEqual(headAfterFirst)
  })
})
