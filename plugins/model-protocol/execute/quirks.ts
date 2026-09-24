// `quirks` 声明式机械解释（规范源：厂商适配插件；本插件只按 impl 分派有界适配器，不加厂商分支）。
// 三协议自带默认怪癖，厂商 quirks 只覆盖差异、缺省取协议默认。

import type { Json, Rec } from './types.ts'
import { isRecord } from './plan.ts'

export interface Quirks {
  impl: 'protocol' | 'sdk'
  protocol: string
  sdk_package: string | null
  auth_style: 'bearer' | 'query' | 'header'
  auth_header: string | null
  system_role: string
  reasoning_field: string | null
  reasoning_map: Rec
  reasoning_response_field: string | null
  max_tokens_field: string
  models_path: string
  stream_usage: 'final_chunk' | 'separate' | 'none'
  extra_headers: Rec
  note: string | null
}

/** 三协议默认怪癖（2026-09-20 修订口径）。 */
export const PROTOCOL_DEFAULTS: Record<string, Rec> = {
  'openai-chat': {
    impl: 'protocol',
    auth_style: 'bearer',
    system_role: 'system',
    // 现代 OpenAI 兼容端点的推理档位字段；仅当所选模型有档位（models.dev `reasoning_options`）时才会传，
    // 厂商显式 quirks 优先覆盖。
    reasoning_field: 'reasoning_effort',
    reasoning_map: { low: 'low', medium: 'medium', high: 'high' },
    max_tokens_field: 'max_tokens',
    models_path: '/models',
    stream_usage: 'final_chunk',
  },
  'openai-responses': {
    impl: 'protocol',
    auth_style: 'bearer',
    system_role: 'system',
    max_tokens_field: 'max_output_tokens',
    models_path: '/models',
    stream_usage: 'final_chunk',
  },
  'anthropic-messages': {
    impl: 'protocol',
    auth_style: 'header',
    auth_header: 'x-api-key',
    system_role: 'system',
    max_tokens_field: 'max_tokens',
    models_path: '/models',
    stream_usage: 'separate',
    extra_headers: { 'anthropic-version': '2023-06-01' },
  },
}

function str(value: Json | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function strOrNull(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** 归一 quirks：协议默认 + 厂商覆盖；`protocolOverride` 优先（自定义厂商从 config 给）。 */
export function normalizeQuirks(raw: Json | undefined, protocolOverride?: string | null): Quirks {
  const source = isRecord(raw) ? raw : {}
  const protocol = protocolOverride ?? str(source['protocol'], 'openai-chat')
  const defaults = PROTOCOL_DEFAULTS[protocol] ?? {}
  const pick = (key: string): Json | undefined =>
    source[key] !== undefined ? source[key] : defaults[key]
  const extra = isRecord(pick('extra_headers')) ? (pick('extra_headers') as Rec) : {}
  const impl = str(pick('impl'), 'protocol')
  return {
    impl: impl === 'sdk' ? 'sdk' : 'protocol',
    protocol,
    sdk_package: strOrNull(pick('sdk_package')),
    auth_style: normalizeAuthStyle(pick('auth_style')),
    auth_header: strOrNull(pick('auth_header')),
    system_role: str(pick('system_role'), 'system'),
    reasoning_field: strOrNull(pick('reasoning_field')),
    reasoning_map: isRecord(pick('reasoning_map')) ? (pick('reasoning_map') as Rec) : {},
    reasoning_response_field: strOrNull(pick('reasoning_response_field')),
    max_tokens_field: str(pick('max_tokens_field'), 'max_tokens'),
    models_path: str(pick('models_path'), '/models'),
    stream_usage: normalizeStreamUsage(pick('stream_usage')),
    extra_headers: extra,
    note: strOrNull(pick('note')),
  }
}

function normalizeAuthStyle(value: Json | undefined): Quirks['auth_style'] {
  if (value === 'query' || value === 'header' || value === 'bearer') return value
  return 'bearer'
}

function normalizeStreamUsage(value: Json | undefined): Quirks['stream_usage'] {
  if (value === 'separate' || value === 'none' || value === 'final_chunk') return value
  return 'final_chunk'
}

/** 归一推理档位 -> 厂商编码；无档位 / 不可传返回 null。 */
export function encodeReasoning(quirks: Quirks, level: Json | undefined): { path: string; value: Json } | null {
  if (typeof level !== 'string' || level.length === 0) return null
  if (quirks.reasoning_field === null) return null
  const map = quirks.reasoning_map
  const keys = Object.keys(map)
  if (keys.length === 0) return null
  const mapped = map[level]
  if (mapped === undefined) return null
  return { path: quirks.reasoning_field, value: mapped }
}

/** 按点路径写值（如 sdk 的 thinkingConfig.thinkingBudget；扁平路径同样适用）。
 *  路径段含 JS 原型键即整体放弃（声明是外部数据，不得借它改原型 / 覆写构造器）。 */
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function setByPath(target: Rec, path: string, value: Json): void {
  const segments = path.split('.').filter((segment) => segment.length > 0)
  if (segments.length === 0) return
  if (segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) return
  let cursor: Rec = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string
    const next = cursor[segment]
    if (!isRecord(next)) cursor[segment] = {}
    cursor = cursor[segment] as Rec
  }
  cursor[segments[segments.length - 1] as string] = value
}

/** 拼接 base_url 与相对路径；path 是完整 URL 时原样返回。 */
export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** 按 auth_style 生成鉴权 URL 与头（query 追加到 URL，bearer / header 进头）。 */
export function applyAuth(
  url: string,
  quirks: Quirks,
  secret: string | null,
): { url: string; headers: Rec } {
  const headers: Rec = { ...quirks.extra_headers }
  if (secret === null || secret.length === 0) return { url, headers }
  if (quirks.auth_style === 'bearer') {
    headers['authorization'] = `Bearer ${secret}`
    return { url, headers }
  }
  if (quirks.auth_style === 'header') {
    headers[(quirks.auth_header ?? 'x-api-key').toLowerCase()] = secret
    return { url, headers }
  }
  const separator = url.includes('?') ? '&' : '?'
  return { url: `${url}${separator}key=${encodeURIComponent(secret)}`, headers }
}
