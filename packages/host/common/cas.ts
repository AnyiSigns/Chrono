// 内容寻址存储（CAS）的共用机械件：64-hex 摘要判定、CAS 文件路径与规范 base64 往返。
// 源码 blob 区与资产区机械同构，命名与校验口径共用这一份。

import { resolve } from 'node:path'

const SHA256_HEX = /^[0-9a-f]{64}$/

/** 64 位小写十六进制摘要（sha256 全长，不截断）。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value)
}

/** CAS 文件路径：sha256 十六进制；非 64 hex 一律 null（防路径穿越）。 */
export function casFilePath(dir: string, sha256: string): string | null {
  if (!SHA256_HEX.test(sha256)) return null
  return resolve(dir, sha256)
}

/** 规范 base64 解码：只收往返一致的编码（防 URL-safe / 脏字符被静默吞掉）；非法返回 null。 */
export function decodeBase64Strict(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.toString('base64') === value ? decoded : null
  } catch {
    return null
  }
}
