// 源码字节内容寻址存储（CAS）：世界只存 pointer def，字节本体住 `state/blobs/<sha256>`。
// 与资产面机械同构（64-hex 命名、只增、离线 GC），但保留策略不同——源码字节属 ④ 不可重算，
// 覆盖全部世代、必须随世界一起备份。
//
// pointer def 形如 `{ body: { kind:'blob', sha256, size } }`：`kind` 是唯一判别位，
// 旧读取器要求 `body` 为字符串，遇对象体安全失败而非把哈希串当内容写出。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { casFilePath, isSha256Hex } from './common/cas.ts'
import { writeFileAtomic } from './common/fs-atomic.ts'
import { gcDirs } from './common/gc-dirs.ts'
import type { Json, World } from '../kernel/index.ts'

/** pointer def 判别键：读取侧据此把对象体 blob 认作内容引用，而非文件内容。 */
export const BLOB_POINTER_KIND = 'blob'

/** 源码 blob 的指针形态（`put` 的 def body）。 */
export interface BlobPointer {
  kind: 'blob'
  sha256: string
  size: number
  [key: string]: Json
}

export type BlobPutResult = { ok: true; pointer: BlobPointer } | { ok: false; code: 'bad_blob' }

export type BlobReadResult =
  { ok: true; bytes: Buffer } | { ok: false; code: 'bad_blob' | 'blob_missing' }

export interface BlobGcReport {
  /** 扫描到的 64-hex 文件数。 */
  scanned: number
  /** 被删的 sha256 清单（排序）。 */
  removed: string[]
  /** 世界仍引用的文件数。 */
  kept: number
  /** 删不掉的项（含原因），由调用方落运维日志，不阻断。 */
  failed: { sha256: string; reason: string }[]
}

/** 内容摘要：原始字节的 sha256 十六进制，兼作 CAS 文件名与读取校验。 */
export function blobSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** CAS 文件路径：sha256 十六进制；非 64 hex 一律拒绝（防路径穿越）。 */
export function blobFile(dir: string, sha256: string): string | null {
  return casFilePath(dir, sha256)
}

/** 构造 pointer def body：字节摘要 + 长度，键即 `H({ body: pointer })`。 */
export function blobPointerOf(sha256: string, size: number): BlobPointer {
  return { kind: BLOB_POINTER_KIND, sha256, size }
}

/**
 * 判别对象体是否为 blob pointer：只认 64-hex sha256 与非负整数 size，
 * 避免把业务数据里恰好带 `kind:'blob'` 的普通对象误判成内容引用。
 */
export function isBlobPointer(value: Json | undefined): value is BlobPointer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as { [k: string]: Json }
  return (
    record['kind'] === BLOB_POINTER_KIND &&
    isSha256Hex(record['sha256']) &&
    typeof record['size'] === 'number' &&
    Number.isInteger(record['size']) &&
    record['size'] >= 0
  )
}

/** 入库：原始字节 → 校验摘要 → 内容寻址落盘（已存在即幂等复用）；返回 pointer def body。 */
export function putBlob(dir: string, bytes: Uint8Array): BlobPutResult {
  if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'bad_blob' }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const sha256 = blobSha256(buffer)
  const file = blobFile(dir, sha256)
  if (file === null) return { ok: false, code: 'bad_blob' }
  // 内容寻址保证同名同内容；已存在不再重写，避免无谓 IO 与 mtime 抖动
  if (!existsSync(file)) writeFileAtomic(file, buffer)
  return { ok: true, pointer: blobPointerOf(sha256, buffer.length) }
}

/** 取字节：按 pointer 读回并校验长度与摘要；缺失 → `blob_missing`，损坏 → `bad_blob`。 */
export function getBlob(dir: string, pointer: BlobPointer): BlobReadResult {
  const file = blobFile(dir, pointer.sha256)
  if (file === null) return { ok: false, code: 'bad_blob' }
  if (!existsSync(file)) return { ok: false, code: 'blob_missing' }
  const bytes = readFileSync(file)
  if (bytes.length !== pointer.size) return { ok: false, code: 'bad_blob' }
  if (blobSha256(bytes) !== pointer.sha256) return { ok: false, code: 'bad_blob' }
  return { ok: true, bytes }
}

/**
 * 机械收集世界里所有世代引用的源码 blob sha256：沿每个身份每个世代的 `commit.body.tree`
 * 递归遍历 tree defs，只认 file entry 上的 pointer def。
 *
 * 可达集覆盖**全部世代**而非 active + N——`set_active` 可指回任意世代，字节必须留到回滚可用；
 * inline 旧世代的 body 是字符串，不贡献可达 sha256（其字节在链上，不占 CAS）。
 */
export function collectBlobRefs(world: World): Set<string> {
  const keep = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    if (identity === undefined) continue
    for (const gen of identity.gens) {
      const tree = (world.defs[gen.payload]?.body as { tree?: Json } | undefined)?.tree
      if (typeof tree === 'string') stack.push(tree)
    }
  }
  while (stack.length > 0) {
    const treeHash = stack.pop() as string
    if (visited.has(treeHash)) continue
    visited.add(treeHash)
    const entries = (world.defs[treeHash]?.body as { entries?: Json } | undefined)?.entries
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as { [k: string]: Json }
      const hash = record['hash']
      if (typeof hash !== 'string') continue
      const mode = record['mode']
      if (mode === 'dir') {
        stack.push(hash)
        continue
      }
      if (mode !== 'file') continue
      const body = world.defs[hash]?.body
      if (isBlobPointer(body)) keep.add(body.sha256)
    }
  }
  return keep
}

/**
 * 离线回收：删除源码 CAS 区里「世界全部世代无引用」的 64-hex 字节。
 * 只动 64-hex 命名的文件（临时文件 / 非源码字节不碰）；删不掉不致命，记入 `failed`。
 */
export function gcBlobs(dir: string, keep: ReadonlySet<string>): BlobGcReport {
  const report = gcDirs(dir, {
    select: (name) => isSha256Hex(name),
    keep: (name) => keep.has(name),
    remove: (name) => {
      const target = casFilePath(dir, name)
      if (target !== null) rmSync(target, { force: true })
    },
  })
  return {
    scanned: report.scanned,
    removed: report.removed,
    kept: report.kept,
    failed: report.failed.map((item) => ({ sha256: item.name, reason: item.reason })),
  }
}
