// 基础世界 def 分片存储 + 按需加载。
// 分片按 def 键（内容哈希）前 N 位十六进制字符命名：`<prefix>.jsonl`，每行一条 `{h,d}`。
// `DefStore` 只按需读分片，LRU 缓存已读 def；缺分片 / 坏行 fail-open（视作缺 def，不炸）。
// `createLazyDefs` 把 store 包成与普通 defs 表同形的对象：内核照常按下标读 / 写 / 列键，
// 但 `Object.keys`、判存在、克隆都不读 body——只有真正取 def 才触发一次分片读。
// 写入走内存覆盖层（副本独立），底层分片保持只读。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAZY_DEFS } from '../../kernel/index.ts'
import type { Def, Hash } from '../../kernel/index.ts'

/** 单 store 的 LRU def 上限（缺省）：约几千份 body，远低于整世界规模。 */
export const DEFAULT_DEF_CACHE = 4096

export interface DefStoreStats {
  /** 命中缓存次数。 */
  hits: number
  /** 未命中且键在清单内的次数。 */
  misses: number
  /** 分片文件读取次数（按需加载的核心指标）。 */
  loads: number
  /** 读过的不同分片数。 */
  shards: number
}

export interface DefStoreOptions {
  /** 分片目录（`<prefix>.jsonl` 所在目录）。 */
  dir: string
  /** 分片前缀长度（十六进制字符数）。 */
  shard: number
  /** def 键清单（内容哈希，落盘时的全集）。 */
  hashes: Hash[]
  /** LRU def 上限；缺省 `DEFAULT_DEF_CACHE`。 */
  cacheLimit?: number
}

/**
 * 分片 def 存储：清单在内存（判存在 / 列键零 IO），body 按分片惰性读入 LRU。
 * 读侧 fail-open：分片缺失或行损坏只当该 def 不存在，不抛。
 */
export class DefStore {
  private readonly dir: string
  private readonly shard: number
  private readonly manifest: Set<Hash>
  private readonly order: Hash[]
  private readonly cache = new Map<Hash, Def>()
  private readonly seenShards = new Set<string>()
  private readonly cacheLimit: number
  readonly stats: DefStoreStats = { hits: 0, misses: 0, loads: 0, shards: 0 }

  constructor(options: DefStoreOptions) {
    this.dir = options.dir
    this.shard = options.shard
    this.order = [...options.hashes]
    this.manifest = new Set(this.order)
    this.cacheLimit = options.cacheLimit ?? DEFAULT_DEF_CACHE
  }

  /** 键是否在清单内（零 IO）。 */
  has(hash: Hash): boolean {
    return this.manifest.has(hash)
  }

  /** def 键清单（零 IO，落盘顺序）。 */
  hashes(): Hash[] {
    return this.order
  }

  /** 按哈希取 def：缓存优先，未命中读其分片；缺分片 / 坏行 → undefined（fail-open）。 */
  get(hash: Hash): Def | undefined {
    const cached = this.cache.get(hash)
    if (cached !== undefined) {
      this.stats.hits += 1
      this.touch(hash, cached)
      return cached
    }
    if (!this.manifest.has(hash)) return undefined
    this.stats.misses += 1
    const loaded = this.loadShard(hash.slice(0, this.shard))
    const def = loaded.get(hash)
    if (def === undefined) return undefined
    // 分片已整片解析：整片入 LRU（请求项最后 touch，避免被同片项挤掉）
    for (const [key, value] of loaded) this.touch(key, value)
    this.touch(hash, def)
    return def
  }

  /** 批量取：逐键走 `get`（同分片只读一次）。 */
  getMany(hashes: Hash[]): Map<Hash, Def> {
    const out = new Map<Hash, Def>()
    for (const hash of hashes) {
      const def = this.get(hash)
      if (def !== undefined) out.set(hash, def)
    }
    return out
  }

  /** 已缓存 def 数（诊断 / 测试）。 */
  cached(): number {
    return this.cache.size
  }

  private touch(hash: Hash, def: Def): void {
    if (this.cache.has(hash)) this.cache.delete(hash)
    this.cache.set(hash, def)
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private loadShard(prefix: string): Map<Hash, Def> {
    const out = new Map<Hash, Def>()
    const file = join(this.dir, `${prefix}.jsonl`)
    this.stats.loads += 1
    if (!existsSync(file)) return out
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return out
    }
    if (!this.seenShards.has(prefix)) {
      this.seenShards.add(prefix)
      this.stats.shards = this.seenShards.size
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const record = JSON.parse(line) as { h?: unknown; d?: unknown }
        if (typeof record.h === 'string' && record.d !== undefined) {
          out.set(record.h, record.d as unknown as Def)
        }
      } catch {
        // fail-open：坏行跳过，不炸整个分片
      }
    }
    return out
  }
}

interface LazyHandle {
  has(hash: Hash): boolean
  hashes(): Hash[]
  clone(): Record<Hash, Def>
}

/**
 * 把 `DefStore` 包成与普通 defs 表同形的对象（惰性代理）。
 * 语义：下标读走覆盖层 → 底层分片；`Object.keys` / `in` / 克隆只看清单与覆盖层，不读 body；
 * 下标写 / delete 只改内存覆盖层，不落盘、不改底层分片。
 * @param store 底层分片存储（被多个克隆共享）
 */
export function createLazyDefs(store: DefStore): Record<Hash, Def> {
  return makeLazy(store, new Map<Hash, Def>(), new Set<Hash>())
}

function makeLazy(store: DefStore, overlay: Map<Hash, Def>, deleted: Set<Hash>): Record<Hash, Def> {
  const read = (hash: Hash): Def | undefined => {
    if (overlay.has(hash)) return overlay.get(hash)
    if (deleted.has(hash)) return undefined
    return store.get(hash)
  }
  const present = (hash: string): boolean =>
    overlay.has(hash) || (store.has(hash) && !deleted.has(hash))
  const own = (): Hash[] => {
    const out: Hash[] = []
    for (const hash of store.hashes()) if (!deleted.has(hash)) out.push(hash)
    for (const hash of overlay.keys()) {
      if (!deleted.has(hash) && !store.has(hash)) out.push(hash)
    }
    return out
  }
  const handle: LazyHandle = {
    has: (hash) => present(hash),
    hashes: own,
    clone: () => makeLazy(store, new Map(overlay), new Set(deleted)),
  }
  const target: Record<string, unknown> = {}
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, key) {
      if (key === LAZY_DEFS) return handle
      if (typeof key !== 'string') return Reflect.get(t, key)
      return read(key)
    },
    has(t, key) {
      if (typeof key !== 'string') return Reflect.has(t, key)
      return present(key)
    },
    ownKeys(t) {
      return [...own(), ...Reflect.ownKeys(t)]
    },
    getOwnPropertyDescriptor(t, key) {
      // 只报「存在且可枚举」，不在描述符里取 body——`Object.keys` / `Object.hasOwn` 因此零读盘
      if (typeof key === 'string' && present(key)) {
        return {
          enumerable: true,
          configurable: true,
          get: () => read(key),
          set: (value: Def) => {
            overlay.set(key, value)
            deleted.delete(key)
          },
        }
      }
      return Reflect.getOwnPropertyDescriptor(t, key)
    },
    set(t, key, value) {
      if (typeof key !== 'string') return Reflect.set(t, key, value)
      overlay.set(key, value as Def)
      deleted.delete(key)
      return true
    },
    deleteProperty(t, key) {
      if (typeof key !== 'string') return Reflect.deleteProperty(t, key)
      overlay.delete(key)
      deleted.add(key)
      return true
    },
  }
  return new Proxy(target, handler) as unknown as Record<Hash, Def>
}
