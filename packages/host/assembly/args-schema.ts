// 命令 `argsSchema` 方言（v1 · JSON Schema 白名单子集）：元校验（入世）与机械校验（命令入口）。
// 只查形态：不执行正则、不触网、无副作用；校验器用显式栈防深嵌套。
// 方言口径见 `docs/plugins.md` §二，落点见 `docs/plans/host-plan.md` A13。

import { deepEq, t } from '../../kernel/index.ts'
import type { Json } from '../../kernel/index.ts'

type Rec = { [k: string]: Json }

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
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
/** 注记键：合法但不参与校验。 */
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: Json | undefined): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export type ArgsSchemaCheck = { ok: true } | { ok: false; reason: string }

/**
 * 元校验：`argsSchema` 的 def body 必须整体落在白名单子集内（含嵌套 schema）。
 * 白名单外关键词 / 形态非法 → 不通过，调用方按 `bad_args_schema` 整包拒。
 * @param schema `commands[].argsSchema` 解析出的 def body
 * @returns 通过，或首个违规的可读原因
 */
export function validateArgsSchema(schema: Json): ArgsSchemaCheck {
  const stack: Json[] = [schema]
  while (stack.length > 0) {
    const current = stack.pop() as Json
    if (!isRecord(current)) return { ok: false, reason: 'schema must be an object' }
    for (const key of Object.keys(current)) {
      const value = current[key]
      if (ANNOTATIONS.has(key)) continue
      if (!KEYWORDS.has(key)) return { ok: false, reason: `unsupported keyword: ${key}` }
      switch (key) {
        case 'type': {
          if (typeof value !== 'string' || !TYPES.has(value)) {
            return { ok: false, reason: 'bad type' }
          }
          break
        }
        case 'properties': {
          if (!isRecord(value)) return { ok: false, reason: 'bad properties' }
          for (const child of Object.values(value)) stack.push(child)
          break
        }
        case 'required': {
          if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
            return { ok: false, reason: 'bad required' }
          }
          break
        }
        case 'additionalProperties': {
          if (typeof value !== 'boolean') return { ok: false, reason: 'bad additionalProperties' }
          break
        }
        case 'items': {
          stack.push(value)
          break
        }
        case 'enum': {
          if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: 'bad enum' }
          break
        }
        case 'const': {
          break
        }
        case 'minimum':
        case 'maximum': {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, reason: `bad ${key}` }
          }
          break
        }
        case 'minItems':
        case 'maxItems':
        case 'minLength':
        case 'maxLength': {
          if (!isNonNegativeInteger(value)) return { ok: false, reason: `bad ${key}` }
          break
        }
      }
    }
  }
  return { ok: true }
}

/** 值标签；非有限数不进值域（校验失败而非抛出）。 */
function typeOf(value: Json): string | null {
  try {
    return t(value)
  } catch {
    return null
  }
}

function typeMatches(name: Json, value: Json): boolean {
  const label = typeOf(value)
  switch (name) {
    case 'object':
      return label === 'Json'
    case 'array':
      return label === 'List'
    case 'string':
      return label === 'Str'
    case 'number':
      return label === 'Int'
    case 'integer':
      return label === 'Int' && Number.isInteger(value)
    case 'boolean':
      return label === 'Bool'
    case 'null':
      return label === 'None'
    default:
      return false
  }
}

function codePointLength(text: string): number {
  return [...text].length
}

/**
 * 机械校验 `args` 是否符合（已元校验的）白名单子集 schema。
 * 组合语义：同一 schema 的多个关键词全部满足；`properties` / `required` /
 * `additionalProperties` 只作用于 object，`items` 只作用于 array，数值与长度界只作用于对应类型。
 * @param schema 已通过 `validateArgsSchema` 的 schema body
 * @param args 命令参数（缺省按 `null`）
 * @returns 是否符合
 */
export function validateArgs(schema: Json, args: Json): boolean {
  const stack: Array<[Json, Json]> = [[schema, args]]
  while (stack.length > 0) {
    const [current, value] = stack.pop() as [Json, Json]
    if (!isRecord(current)) return false
    if (current['type'] !== undefined && !typeMatches(current['type'], value)) return false
    if (Array.isArray(current['enum'])) {
      if (!current['enum'].some((item) => deepEq(item, value))) return false
    }
    if ('const' in current && !deepEq(current['const'], value)) return false
    if (typeof value === 'number') {
      if (typeof current['minimum'] === 'number' && value < current['minimum']) return false
      if (typeof current['maximum'] === 'number' && value > current['maximum']) return false
    }
    if (Array.isArray(value)) {
      if (typeof current['minItems'] === 'number' && value.length < current['minItems'])
        return false
      if (typeof current['maxItems'] === 'number' && value.length > current['maxItems'])
        return false
      if (current['items'] !== undefined) {
        for (const item of value) stack.push([current['items'], item])
      }
    }
    if (typeof value === 'string') {
      const length = codePointLength(value)
      if (typeof current['minLength'] === 'number' && length < current['minLength']) return false
      if (typeof current['maxLength'] === 'number' && length > current['maxLength']) return false
    }
    if (isRecord(value)) {
      const properties = isRecord(current['properties']) ? current['properties'] : {}
      if (Array.isArray(current['required'])) {
        for (const key of current['required']) {
          if (!Object.hasOwn(value, key as string)) return false
        }
      }
      if (current['additionalProperties'] === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) return false
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) stack.push([child, value[key]])
      }
    }
  }
  return true
}
