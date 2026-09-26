// 密钥本地存储面：宿主直写用户本地文件，不经 run、不进世界、不进审计。
// 文件形态 = `{ [name]: value }` 的 JSON 对象；纯 fs + 原子写，明文只活在本机文件与调用方内存。
// 损坏文件 fail-closed：读写一律不静默以空表覆写，避免丢密钥。

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './common/fs-atomic.ts'
import { PROTOTYPE_KEYS, isRecord } from './common/json.ts'
import type { Json } from '../kernel/index.ts'

/** 本地密钥文件的内容形态：名 → 值（值一律字符串）。 */
export type SecretsFile = { [name: string]: string }

/** 密钥名长度上限。 */
export const MAX_SECRET_NAME_LENGTH = 256

/** 单个密钥值字节上限（64 KiB）：防无界文件。 */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024

/** 密钥文件落盘权限：仅所有者可读写。 */
const SECRETS_FILE_MODE = 0o600

/** 合法密钥名：非空、不超长、无 NUL、非原型污染键。 */
export function isValidSecretName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_SECRET_NAME_LENGTH) return false
  if (name.includes('\u0000')) return false
  if (PROTOTYPE_KEYS.has(name)) return false
  return true
}

/** 读取结果：缺失 → 空表；存在但解析失败 / 非对象 → 损坏。 */
export type SecretsReadResult =
  { ok: true; secrets: SecretsFile } | { ok: false; reason: 'corrupt' }

/** 写入 / 删除结果：`bad_name` / `too_large` 是入参问题，`corrupt` 是现存文件损坏。 */
export type SecretWriteResult =
  { ok: true } | { ok: false; reason: 'bad_name' | 'too_large' | 'corrupt' }

/** 读取本地密钥文件：缺失 → 空表；解析失败 / 非对象 → 损坏（不静默当空表）。 */
export function readSecrets(file: string): SecretsReadResult {
  if (!existsSync(file)) return { ok: true, secrets: {} }
  let parsed: Json
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'corrupt' }
  const out: SecretsFile = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[name] = value
  }
  return { ok: true, secrets: out }
}

/** 写入一项密钥（保留其余项）：读-改-写 + 原子落盘（0600）；损坏文件 fail-closed。 */
export function putSecret(file: string, name: string, value: string): SecretWriteResult {
  if (!isValidSecretName(name)) return { ok: false, reason: 'bad_name' }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
    return { ok: false, reason: 'too_large' }
  }
  const read = readSecrets(file)
  if (!read.ok) return read
  const secrets = read.secrets
  secrets[name] = value
  writeFileAtomic(file, JSON.stringify(secrets), SECRETS_FILE_MODE)
  return { ok: true }
}

/** 删除一项密钥（不存在即无操作）：保留其余项并原子落盘（0600）；损坏文件 fail-closed。 */
export function deleteSecret(file: string, name: string): SecretWriteResult {
  if (!isValidSecretName(name)) return { ok: false, reason: 'bad_name' }
  const read = readSecrets(file)
  if (!read.ok) return read
  const secrets = read.secrets
  delete secrets[name]
  writeFileAtomic(file, JSON.stringify(secrets), SECRETS_FILE_MODE)
  return { ok: true }
}
