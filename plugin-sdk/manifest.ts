// manifest 派生：读同包 `plugin.json` 取 `identity` / `implements` / `methods` / `protocol` / `state`。
// 服务自述与声明一致由本模块保证；缺声明按 capability / 缺省档回落，不阻断装载。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

/** 服务握手回带的 manifest（docs/protocol.md §2.1）。 */
export interface ServiceManifest {
  v: string
  identity: string
  implements: string[]
  methods: Record<string, string[]>
  protocol: string
  state: string
}

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

function stringList(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** 从 plugin.json 派生 manifest；缺声明按 capability / 缺省状态档回落。 */
export function deriveManifest(
  plugin: Rec,
  capability: string,
  defaultState: string,
): ServiceManifest {
  const identity =
    typeof plugin['identity'] === 'string' ? (plugin['identity'] as string) : capability
  const implementsList = Array.isArray(plugin['implements'])
    ? stringList(plugin['implements'])
    : [capability]
  const methods = isRecord(plugin['methods']) ? (plugin['methods'] as Rec) : {}
  const protocol = typeof plugin['protocol'] === 'string' ? (plugin['protocol'] as string) : '1'
  const state = typeof plugin['state'] === 'string' ? (plugin['state'] as string) : defaultState
  return {
    v: '1',
    identity,
    implements: implementsList,
    methods: methods as Record<string, string[]>,
    protocol,
    state,
  }
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
