// 源码字节内容寻址存储（CAS）：世界只存 pointer def，字节本体住 `state/blobs/<sha256>`。
// 与资产面机械同构（64-hex 命名、只增、离线 GC），但保留策略不同——源码字节属 ④ 不可重算，
// 覆盖全部世代、必须随世界一起备份。
//
// pointer def 形如 `{ body: { kind:'blob', sha256, size } }`：`kind` 是唯一判别位，
// 旧读取器要求 `body` 为字符串，遇对象体安全失败而非把哈希串当内容写出。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from './ledger/atomic.ts'
import type { Json } from '../kernel/index.ts'

/** pointer def 判别键：读取侧据此把对象体 blob 认作内容引用，而非文件内容。 */
export const BLOB_POINTER_KIND = 'blob'

const SHA256_HEX = /^[0-9a-f]{64}$/

/** 源码 blob 的指针形态（`put` 的 def body）。 */
export interface BlobPointer {
  kind: 'blob'
  sha256: string
  size: number
  [key: string]: Json
}

export type BlobPutResult = { ok: true; pointer: BlobPointer } | { ok: false; code: 'bad_blob' }

export type BlobReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: 'bad_blob' | 'blob_missing' }

/** 内容摘要：原始字节的 sha256 十六进制，兼作 CAS 文件名与读取校验。 */
export function blobSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** CAS 文件路径：sha256 十六进制；非 64 hex 一律拒绝（防路径穿越）。 */
export function blobFile(dir: string, sha256: string): string | null {
  if (!SHA256_HEX.test(sha256)) return null
  return resolve(dir, sha256)
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
    typeof record['sha256'] === 'string' &&
    SHA256_HEX.test(record['sha256']) &&
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
