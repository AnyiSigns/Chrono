// 入站消息与 directive 草稿的形状校验：只做形态检查，不解释语义（畸形提交不得打崩写者）。
// 结构 op 名清单与 effect 共用 `common/op-names.ts` 的单一真源，不在此另抄一份。

import { OP_NAMES } from '../common/op-names.ts'
import { PROTOTYPE_KEYS, asRecord } from '../common/json.ts'
import { DEFAULT_LIMITS } from '../run-registry.ts'
import type { DirectiveDraft } from '../effect/index.ts'
import type { InboundMessage, Limits } from '../wire.ts'
import type { Json } from '../../kernel/index.ts'

/**
 * 入站帧的机械识别结果：`ok` 附消息；否则 `id` 为可解析的字符串 id（无法按协议配对时为 `null`）。
 * 调用方据 `id` 决定回 `bad_directive` 还是记运维事件并断连，故识别不得静默丢弃原因。
 */
export type ReadMessageResult =
  { ok: true; message: InboundMessage } | { ok: false; id: string | null }

/** 机械识别一条入站消息：`v` / `id` / `kind` 皆字符串，其余字段交各 kind 的 handler 校验。 */
export function readMessage(raw: Json): ReadMessageResult {
  const record = asRecord(raw)
  if (!record) return { ok: false, id: null }
  if (typeof record['id'] !== 'string') return { ok: false, id: null }
  if (typeof record['v'] !== 'string' || typeof record['kind'] !== 'string') {
    return { ok: false, id: record['id'] }
  }
  return { ok: true, message: record as unknown as InboundMessage }
}

/**
 * 机械校验 directives 形态；非法返回 null（不得让畸形提交打崩写者）。
 * eval 的 `ctx` 字段保原样：缺省留给宿主投影，显式给出（含 null）透传。
 */
export function asDirectives(value: unknown): DirectiveDraft[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const record = item as { [k: string]: unknown }
    const kind = record['kind']
    if (kind === 'eval') {
      if (typeof record['entry'] !== 'string' || record['entry'].length === 0) return null
      continue
    }
    if (kind === 'extern') continue
    if (kind === 'write') {
      const request = record['request']
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return null
      const op = (request as { [k: string]: unknown })['op']
      if (typeof op !== 'string' || !OP_NAMES.has(op)) return null
      continue
    }
    return null
  }
  return value as DirectiveDraft[]
}

/** 正整数判定（budget 字段的唯一合法形状）：非有限数 / 浮点 / ≤0 皆不合法。 */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 机械校验入站 `caps`：缺省（undefined）回落空表；否则必须是非数组普通对象且所有值均为布尔。
 * 形状非法返回 null（调用方回 `bad_directive` 并拒该 run，不得透传给内核）。
 * 用 `Object.keys` 显式取键，不 `for...in` 继承链；键命中原型键（`PROTOTYPE_KEYS`）即拒——
 * 以外部数据构造对象键属仓库明令拒绝处，且 `__proto__` 赋值会被静默丢弃（静默变形）。
 */
export function resolveCaps(raw: unknown): Record<string, boolean> | null {
  if (raw === undefined) return {}
  const record = asRecord(raw)
  if (record === null) return null
  const caps: Record<string, boolean> = {}
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_KEYS.has(key)) return null
    const value = record[key]
    if (typeof value !== 'boolean') return null
    caps[key] = value
  }
  return caps
}

/**
 * 机械校验入站 `limits`：缺省（undefined）回落 `DEFAULT_LIMITS`；否则必须是非数组普通对象。
 * 逐字段 `gas` / `depth`：字段缺失取 `DEFAULT_LIMITS` 对应值；字段存在但非正整数返回 null。
 * 未知多余键忽略（budget 只认这两个字段，不解释其余语义）；用 `Object.hasOwn` 显式取键。
 */
export function resolveLimits(raw: unknown): Limits | null {
  if (raw === undefined) return DEFAULT_LIMITS
  const record = asRecord(raw)
  if (record === null) return null
  const gas = Object.hasOwn(record, 'gas') ? record['gas'] : DEFAULT_LIMITS.gas
  const depth = Object.hasOwn(record, 'depth') ? record['depth'] : DEFAULT_LIMITS.depth
  if (!isPositiveInt(gas) || !isPositiveInt(depth)) return null
  return { gas, depth }
}
