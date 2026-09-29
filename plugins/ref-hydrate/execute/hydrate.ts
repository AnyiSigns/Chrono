// 引用水合原语：投影只回引用（`{"def":hash}` 直接标记的哈希列表），本服务沿标记逐跳调宿主只读
// `host.def.read` 取 body，进程内有界缓存。`refs` 已是对象（调用方 / 单测直接给闭包）时原样返回。
// 闭包不完整（缺失 / 越权 / 传输失败）时 fail-closed 抛 `def_unavailable`，不静默空。

import { ServiceError, isRecord } from 'plugin-sdk'
import type { Json, Rec } from 'plugin-sdk'

/** 只读解析通道：按身份 + 哈希列表取 `{defs, missing, denied}`；失败回 null。 */
export type DefReader = (identity: string, hashes: string[]) => Promise<Rec | null>

/** 一次水合的可调上限；缺省见 `DEFAULT_LIMITS`（与拆分前逐字一致）。 */
export interface HydrateLimits {
  /** 进程内缓存条目上限（body 内容寻址不可变，命中即复用）。 */
  maxCache: number
  /** 单次水合的逐跳上限（防坏数据成环）。 */
  maxHops: number
  /** 单次解析请求的哈希数上限（与宿主 `def.read` 上限一致，超出则分批）。 */
  maxReadBatch: number
  /** 不可用哈希清单的硬上限（防异常数据撑爆错误载荷）。 */
  maxUnavailable: number
}

/** 与拆分前一致的默认上限（缓存 4096 / 逐跳 10000 / 单批 256 / 不可用 64）。 */
export const DEFAULT_LIMITS: HydrateLimits = {
  maxCache: 4096,
  maxHops: 10000,
  maxReadBatch: 256,
  maxUnavailable: 64,
}

/**
 * 解析闭包时存在不可用 def（缺失 / 越权）的结构化错误：
 * 本次已处理（进入 `seen`）但最终不在 `out` 的哈希即不可用；闭包不完整时 fail-closed，不静默空。
 */
export class DefUnavailableError extends ServiceError {
  readonly hashes: string[]

  constructor(hashes: string[]) {
    super('def_unavailable', `def unavailable: ${hashes.join(', ')}`)
    this.name = 'DefUnavailableError'
    this.hashes = hashes
  }
}

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

/**
 * 引用水合器：缓存有界且跨调用复用。缓存键含身份——某身份可取回的 body 不得经缓存泄漏给另一身份；
 * 因此同一哈希在不同身份下各自持有条目、各自走一次 `def.read`。
 */
export class RefHydrator {
  private readonly read: DefReader
  private readonly cache = new Map<string, Rec>()

  constructor(read: DefReader) {
    this.read = read
  }

  /** 缓存键：身份 + 哈希（防跨身份越权复用）。 */
  private keyOf(identity: string, hash: string): string {
    return `${identity}\u0000${hash}`
  }

  /** 记入缓存；有界 LRU（超额淘汰最早条目）。 */
  private remember(identity: string, hash: string, body: Rec, maxCache: number): void {
    const key = this.keyOf(identity, hash)
    if (this.cache.has(key)) return
    if (this.cache.size >= maxCache) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, body)
  }

  /** `refs` 是哈希列表 ⇒ 逐跳解析成 `{hash: body}`；已是对象 ⇒ 原样返回。 */
  async hydrate(
    identity: string,
    refs: Json,
    limits: HydrateLimits = DEFAULT_LIMITS,
  ): Promise<Rec> {
    if (isRecord(refs)) return refs
    if (!Array.isArray(refs)) return {}
    const out: Rec = {}
    const seen = new Set<string>()
    let queue = refs.filter((hash): hash is string => typeof hash === 'string')
    let hops = 0
    while (queue.length > 0 && hops < limits.maxHops) {
      hops += 1
      const batch = queue.filter((hash) => !seen.has(hash))
      queue = []
      if (batch.length === 0) break
      for (const hash of batch) seen.add(hash)
      const missing = batch.filter((hash) => !this.cache.has(this.keyOf(identity, hash)))
      for (let i = 0; i < missing.length; i += limits.maxReadBatch) {
        const result = await this.read(identity, missing.slice(i, i + limits.maxReadBatch))
        const defs = result === null ? null : result['defs']
        if (isRecord(defs)) {
          for (const [hash, body] of Object.entries(defs)) {
            if (isRecord(body)) this.remember(identity, hash, body, limits.maxCache)
          }
        }
      }
      for (const hash of batch) {
        const body = this.cache.get(this.keyOf(identity, hash))
        if (body === undefined) continue
        out[hash] = body
        collectMarkers(body, queue)
      }
    }
    const unavailable: string[] = []
    for (const hash of seen) {
      if (Object.hasOwn(out, hash)) continue
      unavailable.push(hash)
      if (unavailable.length >= limits.maxUnavailable) break
    }
    if (unavailable.length > 0) throw new DefUnavailableError(unavailable)
    return out
  }
}
