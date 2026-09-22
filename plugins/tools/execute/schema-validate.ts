// argsSchema 方言（JSON Schema 白名单子集，与宿主同口径，docs/plugins.md §二）与 caps 形状校验。
// 两件事：① 机械校验工具声明的 argsSchema 落在白名单内（白名单外关键词一律拒，不静默忽略）；
// ② 用同一方言校验模型传入的 args。另含 caps 对象形校验（fs.read 必在、net 为字符串 scope）。

import { deepEq } from './json.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 参与校验的白名单关键词。 */
const WHITELIST = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
])

/** 注记关键词：允许出现，但不参与校验。 */
const NOTES = new Set(['title', 'description', 'default', 'examples'])

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const FS_SCOPES = new Set(['none', 'workspace', 'full'])
const NET_SCOPES = new Set(['none', 'limited', 'all', 'unset'])

const NUMERIC_CAPS = ['timeout_ms', 'mem_mb', 'cpu_ms', 'output_max', 'procs_max']

/** 嵌套深度上限：防畸形深嵌套撑爆调用栈。 */
const MAX_DEPTH = 64

export interface CheckResult {
  ok: boolean
  message: string
}

const OK: CheckResult = { ok: true, message: '' }

function fail(message: string): CheckResult {
  return { ok: false, message }
}

// ── ① argsSchema 白名单校验 ────────────────────────────────────────────────

/**
 * 机械校验 argsSchema 是否落在白名单子集内（含各关键词形态）。
 * 白名单外关键词 / 形态非法 → 结构化失败（调用方转 `bad_tool_decl`）。
 */
export function validateArgsSchema(schema: Json, path = 'argsSchema', depth = 0): CheckResult {
  if (depth > MAX_DEPTH) return fail(`${path}: schema too deep`)
  if (!isRecord(schema)) return fail(`${path}: schema must be an object`)
  for (const [key, value] of Object.entries(schema)) {
    if (NOTES.has(key)) continue
    if (!WHITELIST.has(key)) return fail(`${path}: unsupported keyword ${key}`)
    const shape = checkKeyword(key, value, path, depth)
    if (!shape.ok) return shape
  }
  return OK
}

function checkKeyword(key: string, value: Json, path: string, depth: number): CheckResult {
  switch (key) {
    case 'type':
      if (typeof value !== 'string' || !TYPES.has(value)) {
        return fail(`${path}.type: must be one of ${[...TYPES].join('/')}`)
      }
      return OK
    case 'properties': {
      if (!isRecord(value)) return fail(`${path}.properties: must be an object`)
      for (const [name, child] of Object.entries(value)) {
        const result = validateArgsSchema(child, `${path}.properties.${name}`, depth + 1)
        if (!result.ok) return result
      }
      return OK
    }
    case 'required':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return fail(`${path}.required: must be an array of strings`)
      }
      return OK
    case 'additionalProperties':
      if (typeof value !== 'boolean') return fail(`${path}.additionalProperties: must be a boolean`)
      return OK
    case 'items':
      return validateArgsSchema(value, `${path}.items`, depth + 1)
    case 'enum':
      if (!Array.isArray(value) || value.length === 0) return fail(`${path}.enum: must be a non-empty array`)
      return OK
    case 'const':
      return OK
    case 'minimum':
    case 'maximum':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(`${path}.${key}: must be a finite number`)
      }
      return OK
    case 'minItems':
    case 'maxItems':
    case 'minLength':
    case 'maxLength':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return fail(`${path}.${key}: must be a non-negative integer`)
      }
      return OK
    default:
      return OK
  }
}

/** 剥掉白名单外的关键词（只留给外部 MCP 工具：其 inputSchema 来自第三方，不拒、只净化）。 */
export function sanitizeArgsSchema(schema: Json, depth = 0): Json {
  if (depth > MAX_DEPTH || !isRecord(schema)) return { type: 'object' }
  const out: Rec = {}
  for (const [key, value] of Object.entries(schema)) {
    if (NOTES.has(key)) {
      out[key] = value
      continue
    }
    if (!WHITELIST.has(key)) continue
    if (key === 'properties' && isRecord(value)) {
      const properties: Rec = {}
      for (const [name, child] of Object.entries(value)) {
        properties[name] = sanitizeArgsSchema(child, depth + 1)
      }
      out[key] = properties
      continue
    }
    if (key === 'items') {
      out[key] = sanitizeArgsSchema(value, depth + 1)
      continue
    }
    out[key] = value
  }
  return out
}

// ── ② args 校验（同一方言） ────────────────────────────────────────────────

function typeOf(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const kind = typeof value
  if (kind === 'boolean' || kind === 'number' || kind === 'string') return kind
  return 'object'
}

function codePointLength(text: string): number {
  return [...text].length
}

function matchesType(type: string, value: Json): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeOf(value) === type
}

/**
 * 按方言校验 value 是否满足 schema。缺键与 null 不同：`required` 只查键存在；
 * `additionalProperties` 缺省 true。失败回可读原因。
 */
export function validateArgs(schema: Json, value: Json, path = 'args', depth = 0): CheckResult {
  if (depth > MAX_DEPTH) return fail(`${path}: too deep`)
  if (!isRecord(schema)) return OK

  const type = schema['type']
  if (typeof type === 'string' && !matchesType(type, value)) {
    return fail(`${path}: expected ${type}, got ${typeOf(value)}`)
  }

  if (Object.hasOwn(schema, 'const') && !deepEq(schema['const'], value)) {
    return fail(`${path}: value does not equal const`)
  }
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && !enumValues.some((item) => deepEq(item, value))) {
    return fail(`${path}: value not in enum`)
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum']
    if (typeof minimum === 'number' && value < minimum) return fail(`${path}: below minimum`)
    const maximum = schema['maximum']
    if (typeof maximum === 'number' && value > maximum) return fail(`${path}: above maximum`)
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength']
    if (typeof minLength === 'number' && codePointLength(value) < minLength) {
      return fail(`${path}: shorter than minLength`)
    }
    const maxLength = schema['maxLength']
    if (typeof maxLength === 'number' && codePointLength(value) > maxLength) {
      return fail(`${path}: longer than maxLength`)
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems']
    if (typeof minItems === 'number' && value.length < minItems) return fail(`${path}: fewer than minItems`)
    const maxItems = schema['maxItems']
    if (typeof maxItems === 'number' && value.length > maxItems) return fail(`${path}: more than maxItems`)
    const items = schema['items']
    if (isRecord(items)) {
      for (let index = 0; index < value.length; index++) {
        const result = validateArgs(items, value[index], `${path}[${index}]`, depth + 1)
        if (!result.ok) return result
      }
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? (schema['properties'] as Rec) : {}
    const required = Array.isArray(schema['required']) ? (schema['required'] as Json[]) : []
    for (const key of required) {
      if (typeof key === 'string' && !Object.hasOwn(value, key)) {
        return fail(`${path}: missing required ${key}`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const result = validateArgs(properties[key], child, `${path}.${key}`, depth + 1)
        if (!result.ok) return result
        continue
      }
      if (schema['additionalProperties'] === false) {
        return fail(`${path}: unexpected property ${key}`)
      }
    }
  }

  return OK
}

// ── ③ caps 形状校验（与 #25 一致） ─────────────────────────────────────────

export interface CapsResult {
  ok: boolean
  message: string
  caps: Rec | null
}

/**
 * 校验并归一 caps：`{fs:{read,write}, net}` 对象形、含 `fs.read`；`net` 为字符串 scope。
 * 兼容归一：布尔 `false` → `"none"`（旧数据等价），布尔 `true` 无合法含义 → 拒。
 */
export function normalizeCaps(raw: Json, lenient = false): CapsResult {
  if (!isRecord(raw)) {
    if (lenient) return { ok: true, message: '', caps: defaultCaps() }
    return { ok: false, message: 'caps must be an object', caps: null }
  }
  const fs = isRecord(raw['fs']) ? (raw['fs'] as Rec) : {}
  const read = fs['read']
  const write = fs['write']
  if (read === undefined || read === null) {
    if (!lenient) return { ok: false, message: 'caps.fs.read is required', caps: null }
  }
  if (write === undefined || write === null) {
    if (!lenient) return { ok: false, message: 'caps.fs.write is required', caps: null }
  }
  const readScope = read ?? 'none'
  const writeScope = write ?? 'none'
  if (typeof readScope !== 'string' || !FS_SCOPES.has(readScope)) {
    return { ok: false, message: 'caps.fs.read must be none/workspace/full', caps: null }
  }
  if (typeof writeScope !== 'string' || !FS_SCOPES.has(writeScope)) {
    return { ok: false, message: 'caps.fs.write must be none/workspace/full', caps: null }
  }

  const netRaw = raw['net']
  let net: string
  if (netRaw === undefined || netRaw === null) net = 'unset'
  else if (typeof netRaw === 'string') {
    if (!NET_SCOPES.has(netRaw)) {
      return { ok: false, message: 'caps.net must be none/limited/all/unset', caps: null }
    }
    net = netRaw
  } else if (netRaw === false) {
    net = 'none'
  } else {
    return { ok: false, message: 'caps.net must be a string scope (boolean not allowed)', caps: null }
  }

  const caps: Rec = { fs: { read: readScope, write: writeScope }, net }
  for (const key of NUMERIC_CAPS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, message: `caps.${key} must be a non-negative number`, caps: null }
    }
    caps[key] = value
  }
  return { ok: true, message: '', caps }
}

/** 缺省 caps：不触盘、不触网。 */
export function defaultCaps(): Rec {
  return { fs: { read: 'none', write: 'none' }, net: 'unset' }
}
