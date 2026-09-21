// vendors：枚举调用方传入的厂商模板 body（厂商模板身份（vendor-*）的投影 body 由入口 term 读出随 args 传入），
// 回 `{identity, default_base_url, default_auth_ref_name, default_reasoning}` 列表，供引导页预填。
// 本插件只读入参、不读投影、不联网。

import { isRecord } from './plan.ts'
import { BadArgsError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 收集厂商模板为 `{ identity: body }`：支持数组 [{identity, body}] / [{sdk,...}] / 对象 / 顶层 vendor-* 键。 */
export function collectVendorBodies(args: Rec): Rec {
  const bodies: Rec = {}
  const raw = args['vendors']
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue
      const body = isRecord(item['body']) ? (item['body'] as Rec) : item
      bodies[identityOf(item['identity'], body)] = body
    }
  } else if (isRecord(raw)) {
    for (const [identity, body] of Object.entries(raw)) {
      if (isRecord(body)) bodies[identity] = body
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('vendor-') && isRecord(value)) bodies[key] = value
  }
  return bodies
}

function identityOf(explicit: Json | undefined, body: Rec): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const sdk = body['sdk']
  return typeof sdk === 'string' && sdk.length > 0 ? `vendor-${sdk}` : 'vendor-custom'
}

/** 枚举厂商模板；无 vendors 入参回空列表。 */
export function vendors(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const list: Json[] = []
  for (const [identity, body] of Object.entries(collectVendorBodies(args))) {
    list.push({
      identity,
      default_base_url: typeof body['default_base_url'] === 'string' ? body['default_base_url'] : null,
      default_auth_ref_name: typeof body['default_auth_ref_name'] === 'string' ? body['default_auth_ref_name'] : null,
      default_reasoning: Array.isArray(body['default_reasoning']) ? body['default_reasoning'] : null,
    })
  }
  list.sort((a, b) => {
    const left = isRecord(a) ? String(a['identity']) : ''
    const right = isRecord(b) ? String(b['identity']) : ''
    return left < right ? -1 : left > right ? 1 : 0
  })
  return { ok: true, vendors: list }
}
