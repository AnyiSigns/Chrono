// 能力类 `secrets` 的两个方法：resolve（解析成明文）与 list（只回 {name, has}）。
// `auth_ref` 形态校验与 kind 定位留本插件：按 kind 在 secrets-backend 成员间选唯一后端，
// 再反调其 read / list；加 / 减后端不改本文件。
// 服务不读投影、不自取时钟（env.now 无关）；明文只在返回值里，绝不进日志 / stderr / 缓存。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './port-link.ts'
import { SecretError } from './types.ts'
import type { SecretErrorCode } from './types.ts'
import type { SecretBackends } from './port-link.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 密钥名长度上限（与宿主本地存储面同口径）。 */
export const MAX_SECRET_NAME_LENGTH = 256

/** 缺省 kind：auth_ref 未给 kind 时按本地文件面解析（与既有口径一致）。 */
const DEFAULT_KIND = 'local'

/** 原型污染保留键：读后端取值面时一律拒绝。 */
const FORBIDDEN_SECRET_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

/** 后端可原样透传给调用方的结构化码；其余后端失败一律收口成不可读。 */
const PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'secret_missing',
  'secret_unreadable',
  'secret_kind_unsupported',
  'secret_kind_ambiguous',
])

export interface SecretsDeps {
  /** 密钥后端注册表（生产环境经宿主注入的成员表 + 反向调用）。 */
  backends: SecretBackends
}

/** 校验 auth_ref 形态；合法则返回 `{kind, name}`，否则抛 bad_auth_ref。 */
function parseAuthRef(args: Json): { kind: string; name: string } {
  const authRef = isRecord(args) ? args['auth_ref'] : undefined
  if (!isRecord(authRef)) throw new SecretError('bad_auth_ref', 'auth_ref must be an object')
  const rawKind = authRef['kind']
  const kind = rawKind === undefined ? DEFAULT_KIND : rawKind
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new SecretError('bad_auth_ref', 'auth_ref.kind must be a non-empty string')
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

/** 把后端的结构化失败映射成密钥域错误：已知码原样透传，其余一律不可读。 */
function toSecretError(err: unknown): SecretError {
  if (err instanceof BackendError && PASSTHROUGH_CODES.has(err.code)) {
    return new SecretError(err.code as SecretErrorCode, err.message)
  }
  return new SecretError('secret_unreadable', 'secret backend is not resolvable')
}

/** 解析一条引用：按 kind 定位唯一后端并反调其 read；返回明文（仅存调用方内存）。 */
async function resolveSecret(args: Json, deps: SecretsDeps): Promise<Json> {
  const { kind, name } = parseAuthRef(args)
  try {
    return await deps.backends.read(kind, name)
  } catch (err) {
    throw toSecretError(err)
  }
}

/** 列出全部后端里的引用名（只回 `{name, has}`，不回值）；排序由注册表保证。 */
async function listSecrets(deps: SecretsDeps): Promise<Json> {
  try {
    return await deps.backends.list()
  } catch (err) {
    throw toSecretError(err)
  }
}

/** 构造方法表（依赖注入：后端注册表由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: SecretsDeps): Record<string, Handler> {
  return {
    resolve: async (args) => ({ value: await resolveSecret(args, deps), events: [] }),
    list: async () => ({ value: await listSecrets(deps), events: [] }),
  }
}
