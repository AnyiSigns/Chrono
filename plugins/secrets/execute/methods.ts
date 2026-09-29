// 能力类 `secrets` 的两个方法：resolve（解析成明文）与 list（只回 {name, has}）。
// `auth_ref` 形态校验与 `env` kind 取值留本插件；`local` kind 的本地文件读取委派 secrets-local。
// 服务不读投影、不自取时钟（env.now 无关）；明文只在返回值里，绝不进日志 / stderr / 缓存。

import { isRecord } from 'plugin-sdk'
import { LocalSecretsError } from './port-link.ts'
import { SecretError } from './types.ts'
import type { LocalSecretsReader } from './port-link.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 密钥名长度上限（与宿主本地存储面同口径）。 */
export const MAX_SECRET_NAME_LENGTH = 256

/** 原型污染保留键：读进程环境 / 本地文件时一律拒绝。 */
const FORBIDDEN_SECRET_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

export interface SecretsDeps {
  /** 本地密钥读取面（生产环境经反向调用 secrets-local）。 */
  local: LocalSecretsReader
  /** 进程环境（`env` kind 的取值面）。 */
  env: Record<string, string | undefined>
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

/** 把 secrets-local 的结构化失败映射成密钥域错误：仅缺失原样透传，其余一律不可读。 */
function toSecretError(err: unknown): SecretError {
  if (err instanceof LocalSecretsError && err.code === 'secret_missing') {
    return new SecretError('secret_missing', err.message)
  }
  return new SecretError('secret_unreadable', 'local secrets file is not resolvable')
}

/** 解析一条引用：`local` 委派 secrets-local、`env` 读进程环境；返回明文（仅存调用方内存）。 */
async function resolveSecret(args: Json, deps: SecretsDeps): Promise<Json> {
  const { kind, name } = parseAuthRef(args)
  if (kind === 'env') {
    const value = deps.env[name]
    if (value === undefined) throw new SecretError('secret_missing', `env secret not found: ${name}`)
    return value
  }
  try {
    return await deps.local.read(name)
  } catch (err) {
    throw toSecretError(err)
  }
}

/** 列出本地文件里的引用名（只回 `{name, has}`，不回值）；排序由 secrets-local 保证。 */
async function listSecrets(deps: SecretsDeps): Promise<Json> {
  try {
    return await deps.local.list()
  } catch (err) {
    throw toSecretError(err)
  }
}

/** 构造方法表（依赖注入：本地读取面 + 进程环境由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: SecretsDeps): Record<string, Handler> {
  return {
    resolve: async (args) => ({ value: await resolveSecret(args, deps), events: [] }),
    list: async () => ({ value: await listSecrets(deps), events: [] }),
  }
}
