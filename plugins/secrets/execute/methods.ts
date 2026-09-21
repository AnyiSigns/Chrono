// 能力类 `secrets` 的两个方法：resolve（解析成明文）与 list（只回 {name, has}）。
// 服务不读投影、不自取时钟（env.now 无关）；明文只在返回值里，绝不进日志 / stderr / 缓存。

import { readLocalSecrets } from './secrets-file.ts'
import { SecretError } from './types.ts'
import type { Handler, Json, Rec } from './types.ts'

/** 密钥名长度上限（与宿主本地存储面同口径）。 */
export const MAX_SECRET_NAME_LENGTH = 256

/** 原型污染保留键：读进程环境 / 本地文件时一律拒绝。 */
const FORBIDDEN_SECRET_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

export interface SecretsDeps {
  /** 本地密钥文件绝对路径；null = 宿主未注入 CHRONO_PLUGIN_STATE，无法解析。 */
  file: string | null
  /** 进程环境（`env` kind 的取值面）。 */
  env: Record<string, string | undefined>
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验 auth_ref 形态；合法则返回 `{kind, name}`，否则抛 bad_auth_ref。 */
function parseAuthRef(args: Json): { kind: 'local' | 'env'; name: string } {
  const authRef = isRecord(args) ? args['auth_ref'] : undefined
  if (!isRecord(authRef)) throw new SecretError('bad_auth_ref', 'auth_ref must be an object')
  const rawKind = authRef['kind']
  const kind = rawKind === undefined ? 'local' : rawKind
  if (kind !== 'local' && kind !== 'env') {
    throw new SecretError('bad_auth_ref', 'auth_ref.kind must be local or env')
  }
  const name = authRef['name']
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SECRET_NAME_LENGTH) {
    throw new SecretError('bad_auth_ref', 'auth_ref.name must be a non-empty string')
  }
  if (name.includes('\u0000') || FORBIDDEN_SECRET_NAMES.has(name)) {
    throw new SecretError('bad_auth_ref', 'auth_ref.name is not allowed')
  }
  return { kind, name }
}

/** 解析一条引用：`local` 读本地文件、`env` 读进程环境；返回明文（仅存调用方内存）。 */
function resolveSecret(args: Json, deps: SecretsDeps): Json {
  const { kind, name } = parseAuthRef(args)
  if (kind === 'env') {
    const value = deps.env[name]
    if (value === undefined) throw new SecretError('secret_missing', `env secret not found: ${name}`)
    return value
  }
  if (deps.file === null) {
    throw new SecretError('secret_unreadable', 'local secrets file is not resolvable')
  }
  const read = readLocalSecrets(deps.file)
  if (!read.ok) throw new SecretError('secret_unreadable', 'local secrets file is unreadable')
  const value = read.secrets[name]
  if (value === undefined) throw new SecretError('secret_missing', `local secret not found: ${name}`)
  return value
}

/** 列出本地文件里的引用名（只回 `{name, has}`，不回值）；名字排序保确定性。 */
function listSecrets(deps: SecretsDeps): Json {
  if (deps.file === null) {
    throw new SecretError('secret_unreadable', 'local secrets file is not resolvable')
  }
  const read = readLocalSecrets(deps.file)
  if (!read.ok) throw new SecretError('secret_unreadable', 'local secrets file is unreadable')
  return Object.keys(read.secrets)
    .sort()
    .map((name) => ({ name, has: true }))
}

/** 构造方法表（依赖注入：文件路径 + 进程环境由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: SecretsDeps): Record<string, Handler> {
  return {
    resolve: (args) => resolveSecret(args, deps),
    list: () => listSecrets(deps),
  }
}
