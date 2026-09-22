// 源码 CAS 可达性回收单测：`collectBlobRefs` 只认 file entry 上的 pointer def 且覆盖全部世代；
// `gcBlobs` 只删无引用的 64-hex 字节；`runBlobGc` 离线持锁，清理入世被拒后落盘的孤儿字节。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectBlobRefs, gcBlobs, putBlob } from '../blobs.ts'
import { runBlobGc, runSeed } from '../offline.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import type { Json, World } from '../../kernel/index.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

function pointer(sha256: string, size: number): Json {
  return { kind: 'blob', sha256, size }
}

/**
 * 两代代码世代 + 一代数据世代的合成世界：旧世代 active，新世代不在 active 但在 gens 里。
 * inline blob 与数据世代的 payload 都不贡献可达 sha256。
 */
function multiGenerationWorld(): World {
  return {
    defs: {
      c1: { body: { tree: 't1' } },
      t1: {
        body: {
          entries: [
            { name: 'inline.txt', mode: 'file', hash: 'inlineBlob' },
            { name: 'a.bin', mode: 'file', hash: 'pointerA' },
            { name: 'sub', mode: 'dir', hash: 't1sub' },
          ],
        },
      },
      t1sub: { body: { entries: [{ name: 'b.bin', mode: 'file', hash: 'pointerB' }] } },
      inlineBlob: { body: 'inline text' },
      pointerA: { body: pointer(SHA_A, 5) },
      pointerB: { body: pointer(SHA_B, 3) },
      c2: { body: { tree: 't2' } },
      t2: { body: { entries: [{ name: 'c.bin', mode: 'file', hash: 'pointerC' }] } },
      pointerC: { body: pointer(SHA_C, 7) },
      dataDef: { body: { payload: true } },
    },
    ids: {
      toy: {
        gens: [{ payload: 'c1' }, { payload: 'c2' }, { payload: 'dataDef' }],
        active: 'c1',
      },
    },
  } as unknown as World
}

describe('源码 CAS 回收（blobs gc）', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('collectBlobRefs：递归目录 + 全部世代；inline 与数据世代不贡献可达集', () => {
    const keep = collectBlobRefs(multiGenerationWorld())
    // c2 不是 active，但属于「全部世代」，回滚可指回它 → 字节必须可达
    expect([...keep].sort()).toEqual([SHA_A, SHA_B, SHA_C].sort())
  })

  it('collectBlobRefs：非 pointer 的 body（inline / 畸形）不被误判', () => {
    const world = multiGenerationWorld()
    // 把新世代的 pointer 换成 inline 字符串：可达集只应剩旧世代的两个
    world.defs['pointerC'] = { body: 'inline c' }
    expect([...collectBlobRefs(world)].sort()).toEqual([SHA_A, SHA_B].sort())
  })

  it('gcBlobs：孤儿字节被删、被引用字节保留、非 64-hex 不碰', () => {
    const dir = join(root, 'state', 'blobs')
    const keep = putBlob(dir, Buffer.from('keep-bytes'))
    const drop = putBlob(dir, Buffer.from('drop-bytes'))
    if (!keep.ok || !drop.ok) throw new Error('bad blob')
    writeFileSync(join(dir, 'staging.tmp-1'), 'temp')

    const report = gcBlobs(dir, new Set([keep.pointer.sha256]))
    expect(report.scanned).toBe(2)
    expect(report.kept).toBe(1)
    expect(report.removed).toEqual([drop.pointer.sha256])
    expect(report.failed).toEqual([])
    expect(existsSync(join(dir, keep.pointer.sha256))).toBe(true)
    expect(existsSync(join(dir, drop.pointer.sha256))).toBe(false)
    expect(existsSync(join(dir, 'staging.tmp-1'))).toBe(true)
  })

  it('gcBlobs：目录不存在即无操作', () => {
    expect(gcBlobs(join(root, 'state', 'no-blobs'), new Set())).toEqual({
      scanned: 0,
      removed: [],
      kept: 0,
      failed: [],
    })
  })

  it('runBlobGc：入世被拒后落盘的孤儿字节被删、世界引用字节保留', () => {
    const pkgRoot = writeTempPackage(root, { identity: 'toy-cas-gc', members: [] })
    expect(runSeed(root, [{ name: 'toy-cas-gc', path: pkgRoot }]).ok).toBe(true)
    const paths = hostPaths(root)
    const referenced = readdirSync(paths.blobsDir).sort()
    expect(referenced.length).toBeGreaterThan(0)

    const orphan = putBlob(paths.blobsDir, Buffer.from('orphan-bytes'))
    if (!orphan.ok) throw new Error('bad blob')
    expect(existsSync(join(paths.blobsDir, orphan.pointer.sha256))).toBe(true)

    const report = runBlobGc(root)
    expect(report.removed).toEqual([orphan.pointer.sha256])
    expect(report.kept).toBe(referenced.length)
    expect(existsSync(join(paths.blobsDir, orphan.pointer.sha256))).toBe(false)
    for (const sha256 of referenced) {
      expect(existsSync(join(paths.blobsDir, sha256))).toBe(true)
    }
  })
})
