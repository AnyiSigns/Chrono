// `router.select` 的纯判定：候选端口名清单 + 失败码进，选中端口名出。
// 不发起 eff、不调模型、不读投影、不取时间、不用随机——同输入同输出（可回放）。
// 无别名候选时恒返回主名（机械 no-op）；返回的端口名必在候选清单内，否则结构化错误。

import { BadArgsError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 一次选择的解析结果（别名清单与主名已由调用方 / schema 默认合流）。 */
export interface SelectInput {
  candidates: string[]
  failure: string
  aliases: string[]
  primary: string
}

/** 冻结默认值：主名与别名清单来自 schema（调用方缺省时回落）。 */
export interface SelectDefaults {
  primary: string
  aliases: string[]
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串数组字段：缺省回空数组；含非字符串 / 空串即拒。 */
function stringList(value: Json | undefined, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadArgsError(`${field} must be an array`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new BadArgsError(`${field} must contain non-empty strings`)
    }
    out.push(item)
  }
  return out
}

/** 解析 select 入参；形态非法抛 `BadArgsError`（结构化 `bad_args`）。 */
export function parseSelect(args: Json, defaults: SelectDefaults): SelectInput {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const candidates = stringList(args['candidates'], 'candidates')
  if (candidates.length === 0) throw new BadArgsError('candidates must not be empty')
  const failure = args['failure'] === undefined || args['failure'] === null ? '' : args['failure']
  if (typeof failure !== 'string') throw new BadArgsError('failure must be a string')
  const aliases = args['aliases'] === undefined || args['aliases'] === null ? defaults.aliases : stringList(args['aliases'], 'aliases')
  const rawPrimary = args['primary']
  if (rawPrimary !== undefined && rawPrimary !== null && (typeof rawPrimary !== 'string' || rawPrimary.length === 0)) {
    throw new BadArgsError('primary must be a non-empty string')
  }
  const primary = typeof rawPrimary === 'string' ? rawPrimary : defaults.primary
  return { candidates, failure, aliases, primary }
}

/**
 * 选择端口名：候选清单顺序即偏好序，取第一个被声明的别名；无别名候选回主名。
 * 返回选中的端口名（字符串）；选中项不在候选清单内时回结构化错误值。
 */
export function select(input: SelectInput): Json {
  const aliasCandidate = input.candidates.find((candidate) => input.aliases.includes(candidate))
  const chosen = aliasCandidate ?? input.primary
  if (!input.candidates.includes(chosen)) {
    return {
      ok: false,
      error: {
        code: 'no_candidate',
        message: `no candidate: primary ${input.primary} and aliases [${input.aliases.join(', ')}] are not among candidates [${input.candidates.join(', ')}]`,
      },
    }
  }
  return chosen
}
