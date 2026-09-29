// 能力类 `secrets-backend` 的三个方法：read（按名读一条明文）、list（只回 {name, has}）与
// kinds（自述支持的 auth_ref.kind 集，供 `secrets` 按 kind 定位后端）。
// 只做本地文件路径解析与读取；auth_ref 形态与 kind 词表归上层 `secrets`。
// 明文只在返回值里，绝不进日志 / stderr / 缓存。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { readLocalSecrets } from './secrets-file.ts'
import { LocalSecretError } from './types.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 本后端支持的 auth_ref.kind（唯一：宿主本地密钥文件）。 */
export const LOCAL_KINDS: readonly string[] = ['local']

export interface LocalSecretsDeps {
  /** 本地密钥文件绝对路径；null = 宿主未注入 CHRONO_PLUGIN_STATE，无法解析。 */
  file: string | null
}

/** 解析 read 的 args：取引用名；缺失 / 非法抛 bad_args。 */
function parseName(args: Json): string {
  const name = isRecord(args) ? args['name'] : undefined
  if (typeof name !== 'string' || name.length === 0 || name.includes('\u0000')) {
    throw new BadArgsError('name must be a non-empty string')
  }
  return name
}

/** 读取一条引用名对应的明文（仅存调用方内存）。 */
function readSecret(args: Json, deps: LocalSecretsDeps): Json {
  const name = parseName(args)
  if (deps.file === null) {
    throw new LocalSecretError('secret_unreadable', 'local secrets file is not resolvable')
  }
  const read = readLocalSecrets(deps.file)
  if (!read.ok) throw new LocalSecretError('secret_unreadable', 'local secrets file is unreadable')
  const value = read.secrets[name]
  if (value === undefined)
    throw new LocalSecretError('secret_missing', `local secret not found: ${name}`)
  return value
}

/** 列出本地文件里的引用名（只回 `{name, has}`，不回值）；名字排序保确定性。 */
function listSecrets(deps: LocalSecretsDeps): Json {
  if (deps.file === null) {
    throw new LocalSecretError('secret_unreadable', 'local secrets file is not resolvable')
  }
  const read = readLocalSecrets(deps.file)
  if (!read.ok) throw new LocalSecretError('secret_unreadable', 'local secrets file is unreadable')
  return Object.keys(read.secrets)
    .sort()
    .map((name) => ({ name, has: true }))
}

/** 自述本后端支持的 kind（`secrets` 据此在成员间定位）。 */
function kinds(): Json {
  return [...LOCAL_KINDS]
}

/** 构造方法表（依赖注入：文件路径由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: LocalSecretsDeps): Record<string, Handler> {
  return {
    read: (args) => ({ value: readSecret(args, deps), events: [] }),
    list: () => ({ value: listSecrets(deps), events: [] }),
    kinds: () => ({ value: kinds(), events: [] }),
  }
}
