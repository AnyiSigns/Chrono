// 本地密钥文件的路径解析与读取。
// 宿主起服务时只注入 `CHRONO_PLUGIN_STATE`（= `<root>/state/plugins/<id>`），不注入 root；
// 故由它上溯两级得到宿主 state 目录（`<root>/state`），再拼 `secrets.local.json`——
// 与宿主单点解析的 `state/secrets.local.json` 同址。路径归宿主权威，本模块不声明、不创建。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 本地密钥文件名（宿主 `state/` 下）。 */
export const SECRETS_FILE_NAME = 'secrets.local.json'

/** 本地密钥文件的内容形态：名 → 值（值一律字符串）。 */
export type LocalSecrets = Record<string, string>

export type LocalSecretsRead =
  | { ok: true; secrets: LocalSecrets }
  | { ok: false; reason: 'unreadable' }

/**
 * 由宿主注入的 `CHRONO_PLUGIN_STATE` 解析本地密钥文件绝对路径。
 * 未注入（独立运行 / 测试未设置）→ null，调用方按 `secret_unreadable` 收口。
 */
export function secretsFileFromEnv(env: Record<string, string | undefined>): string | null {
  const pluginState = env['CHRONO_PLUGIN_STATE']
  if (typeof pluginState !== 'string' || pluginState.length === 0) return null
  return resolve(pluginState, '..', '..', SECRETS_FILE_NAME)
}

/**
 * 读取本地密钥文件：缺失 → 空表；读取失败 / JSON 非法 / 非对象 → unreadable。
 * 只收字符串值；其余键忽略（不静默当损坏，避免误伤宿主未来扩展）。
 */
export function readLocalSecrets(file: string): LocalSecretsRead {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, secrets: {} }
    return { ok: false, reason: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'unreadable' }
  }
  const secrets: LocalSecrets = Object.create(null) as LocalSecrets
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') secrets[name] = value
  }
  return { ok: true, secrets }
}
