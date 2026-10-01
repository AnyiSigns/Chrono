// manifest 派生：读同包 `plugin.json` 供握手回带。
// 字段口径与 `plugin.json` 声明解析同源（`plugin-sdk/decl.ts`），本模块只负责读文件与从已解析值派生。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './json.ts'
import type { Rec } from './json.ts'
import type { ServiceManifest } from './decl.ts'

export { deriveManifest } from './decl.ts'
export type { ServiceManifest } from './decl.ts'

/** 读同包 `plugin.json`；读取 / 解析失败返回空对象（调用方按缺省回落）。 */
export function readPluginJson(pluginRoot: string): Rec {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
    if (isRecord(parsed)) return parsed
  } catch {
    // plugin.json 缺失 / 非法：按缺省回落；合法插件不会走到这里。
  }
  return {}
}

/**
 * 声明方法集：plugin.json 声明优先，缺声明回落处理器表。
 * @param manifest 已派生的 manifest
 * @param capability 本服务能力类名
 * @param handlers 方法表（回落用键集）
 * @returns 声明方法名集合
 */
export function declaredMethods(
  manifest: ServiceManifest,
  capability: string,
  handlers: Record<string, unknown>,
): Set<string> {
  const declared = manifest.methods[capability]
  if (Array.isArray(declared)) {
    return new Set(declared.filter((method): method is string => typeof method === 'string'))
  }
  return new Set(Object.keys(handlers))
}
