// 身份世代事件（`host.identity.changed`）的失效判定：纯函数，供服务与单测共用。
// 载荷 `{ identity, kind: 'code'|'data', active, prev }`；只有该身份的代码世代变化才需要重取字节。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

/**
 * 判定一条 `host.identity.changed` 是否使某 headless 入口字节缓存失效。
 * 仅当 `kind === 'code'`（该身份代码世代 active 变了）且 `identity` 在 headless 清单内时，
 * 返回该 identity（调用方据此删缓存并重取）；data 世代变化与非 headless 身份返回 null。
 */
export function identityInvalidatesHeadless(
  payload: Json,
  headlessIds: ReadonlySet<string>,
): string | null {
  if (!isRecord(payload)) return null
  if (payload['kind'] !== 'code') return null
  const identity = payload['identity']
  if (typeof identity !== 'string' || identity.length === 0) return null
  return headlessIds.has(identity) ? identity : null
}
