// 能力类 `ref-hydrate` 的唯一方法 `hydrate`：沿 `{def}` 标记逐跳调宿主只读 `host.def.read`，
// 进程内有界缓存、fail-closed（不可用 def 抛 `def_unavailable`）。重逻辑全部住本提供方。

import { BadArgsError, asString, isRecord } from 'plugin-sdk'
import { DEFAULT_LIMITS, RefHydrator } from './hydrate.ts'
import type { DefReader, HydrateLimits } from './hydrate.ts'
import type { Handler, HandlerResult, Json, PortCaller, Rec } from 'plugin-sdk'

/** 宿主只读解析通道（`pins.host`）：按身份 + 哈希列表取 `{defs, missing, denied}`；传输失败回 null。 */
function makeReader(host: PortCaller): DefReader {
  return async (identity, hashes) => {
    const outcome = await host.call('host', 'def.read', { identity, hashes })
    if (!outcome.ok) return null
    return isRecord(outcome.value) ? outcome.value : null
  }
}

/** 取可选正整数上限；缺失回落默认，非法抛 `BadArgsError`。 */
function limitOf(limits: Rec, key: string, fallback: number): number {
  const value = limits[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadArgsError(`${key} must be a positive integer`)
  }
  return value
}

/** 解析可选的 `limits`（snake_case）；缺失回默认，非法抛 `BadArgsError`。 */
function parseLimits(args: Rec): HydrateLimits {
  const raw = args['limits']
  if (raw === undefined) return DEFAULT_LIMITS
  if (!isRecord(raw)) throw new BadArgsError('limits must be an object')
  return {
    maxCache: limitOf(raw, 'max_cache', DEFAULT_LIMITS.maxCache),
    maxHops: limitOf(raw, 'max_hops', DEFAULT_LIMITS.maxHops),
    maxReadBatch: limitOf(raw, 'max_read_batch', DEFAULT_LIMITS.maxReadBatch),
    maxUnavailable: limitOf(raw, 'max_unavailable', DEFAULT_LIMITS.maxUnavailable),
  }
}

/** 构造方法表；`host` 为宿主只读端口，水合器（含缓存）住本实例、跨调用复用。 */
export function createHandlers(host: PortCaller): Record<string, Handler> {
  const hydrator = new RefHydrator(makeReader(host))
  return {
    hydrate: async (args: Json): Promise<HandlerResult> => {
      if (!isRecord(args)) throw new BadArgsError('args must be an object')
      const identity = asString(args['identity'])
      if (identity === null) throw new BadArgsError('identity required')
      const refs = args['refs'] ?? null
      return { value: await hydrator.hydrate(identity, refs, parseLimits(args)), events: [] }
    },
  }
}
