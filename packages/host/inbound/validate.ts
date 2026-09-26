// 入站消息与 directive 草稿的形状校验：只做形态检查，不解释语义（畸形提交不得打崩写者）。
// 结构 op 名清单与 effect 共用 `common/op-names.ts` 的单一真源，不在此另抄一份。

import { OP_NAMES } from '../common/op-names.ts'
import { asRecord } from '../common/json.ts'
import type { DirectiveDraft } from '../effect/index.ts'
import type { InboundMessage } from '../wire.ts'
import type { Json } from '../../kernel/index.ts'

/** 机械识别一条入站消息：`v` / `id` / `kind` 皆字符串，其余字段交各 kind 的 handler 校验。 */
export function readMessage(raw: Json): InboundMessage | null {
  const record = asRecord(raw)
  if (!record) return null
  if (typeof record['v'] !== 'string' || typeof record['id'] !== 'string') return null
  if (typeof record['kind'] !== 'string') return null
  return record as unknown as InboundMessage
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
