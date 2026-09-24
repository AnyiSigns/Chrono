// 引用按需解析：投影只回引用（`{"def":hash}` 直接标记的哈希列表），服务沿标记逐跳调宿主只读
// `host.def.read` 取 body，进程内有界缓存。`refs` 已是对象（调用方 / 单测直接给闭包）时原样返回。

import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 只读解析通道：按身份 + 哈希列表取 `{defs, missing, denied}`；失败回 null。 */
export type DefReader = (identity: string, hashes: string[]) => Promise<Rec | null>

/** 进程内缓存条目上限（body 内容寻址不可变，命中即复用）。 */
const MAX_CACHE = 4096

/** 单次 hydrate 的逐跳上限（防坏数据成环）。 */
const MAX_HOPS = 10000

/** 单次解析请求的哈希数上限（与宿主 `def.read` 上限一致，超出则分批）。 */
const MAX_READ_BATCH = 256

/** 收集一段 JSON 里直接出现的 `{"def":hash}` 标记（64hex）。 */
function collectMarkers(value: Json, out: string[]): void {
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === 'def') {
      const hash = value['def']
      if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) out.push(hash)
      return
    }
    for (const key of keys) collectMarkers(value[key], out)
    return
  }
  if (Array.isArray(value)) for (const item of value) collectMarkers(item, out)
}

export interface RefHydrator {
  /** `refs` 是哈希列表 ⇒ 逐跳解析成 `{hash: body}`；已是对象 ⇒ 原样返回。 */
  hydrate(identity: string, refs: Json): Promise<Rec>
}

/** 构造按需解析器；`read` 为宿主只读解析通道，缓存有界且跨调用复用。 */
export function createRefHydrator(read: DefReader): RefHydrator {
  const cache = new Map<string, Rec>()
  const remember = (hash: string, body: Rec): void => {
    if (cache.has(hash)) return
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(hash, body)
  }
  const hydrate = async (identity: string, refs: Json): Promise<Rec> => {
    if (isRecord(refs)) return refs
    if (!Array.isArray(refs)) return {}
    const out: Rec = {}
    const seen = new Set<string>()
    let queue = refs.filter((hash): hash is string => typeof hash === 'string')
    let hops = 0
    while (queue.length > 0 && hops < MAX_HOPS) {
      hops += 1
      const batch = queue.filter((hash) => !seen.has(hash))
      queue = []
      if (batch.length === 0) break
      for (const hash of batch) seen.add(hash)
      const missing = batch.filter((hash) => !cache.has(hash))
      for (let i = 0; i < missing.length; i += MAX_READ_BATCH) {
        const result = await read(identity, missing.slice(i, i + MAX_READ_BATCH))
        const defs = result === null ? null : result['defs']
        if (isRecord(defs)) {
          for (const [hash, body] of Object.entries(defs)) {
            if (isRecord(body)) remember(hash, body)
          }
        }
      }
      for (const hash of batch) {
        const body = cache.get(hash)
        if (body === undefined) continue
        out[hash] = body
        collectMarkers(body, queue)
      }
    }
    return out
  }
  return { hydrate }
}
