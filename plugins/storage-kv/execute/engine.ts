// storage-kv 存储引擎：按 owner 分目录（一 owner 一个子目录 + 追加日志），零原生依赖。
// 每行一条 JSON 记录（put / del），启动时重放重建内存索引；迁移 / 事务 / 并发全归本插件。
// 命名空间只来自调用帧 `env.emitter`（宿主填写），不读调用方自报的任何 namespace 参数。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { BadArgsError, StoreError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 单值上限：大字节不入帧，二进制走 host.asset 后只把引用存进来。 */
export const MAX_VALUE_BYTES = 256 * 1024
/** 键长度上限。 */
export const MAX_KEY_LENGTH = 512
/** 当前日志 / 元数据格式版本；迁移步骤只增不改。 */
export const TARGET_VERSION = 1

const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface OwnerStore {
  dir: string
  logPath: string
  fd: number
  version: number
  values: Map<string, Json>
  seq: number
}

interface Migration {
  version: number
  up: (store: OwnerStore) => void
}

/** 启动迁移表：版本 1 为初始追加日志格式，无需改写既有记录。 */
export const MIGRATIONS: Migration[] = [{ version: 1, up: () => {} }]

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 命名空间（owner）解析：只认调用帧 `env.emitter`；取不到时归宿主自身 `host`。 */
export function resolveOwner(emitter: Json): string {
  const owner = typeof emitter === 'string' && emitter.length > 0 ? emitter : 'host'
  if (owner.length > 128 || !OWNER_NAME.test(owner)) {
    throw new BadArgsError(`unsafe emitter name: ${owner}`)
  }
  return owner
}

function requireKey(value: Json | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new BadArgsError(`key must be a string of 1..${MAX_KEY_LENGTH} characters`)
  }
  return value
}

function requireValue(value: Json | undefined): Json {
  if (value === undefined) throw new BadArgsError('value is required')
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  if (bytes > MAX_VALUE_BYTES) {
    throw new StoreError(
      'payload_too_large',
      `value ${bytes} bytes exceeds ${MAX_VALUE_BYTES}; store bytes via host.asset and pass the reference`,
    )
  }
  return value
}

/** 读文件末尾到最后一个换行：截掉撕裂的半条记录，返回完整前缀字节。 */
function dropTornTail(logPath: string): void {
  if (!existsSync(logPath)) return
  const raw = readFileSync(logPath)
  if (raw.length === 0) return
  const lastNewline = raw.lastIndexOf(0x0a)
  const validBytes = lastNewline + 1
  if (validBytes < raw.length) truncateSync(logPath, validBytes)
}

function replay(logPath: string, store: OwnerStore): void {
  if (!existsSync(logPath)) return
  const text = readFileSync(logPath, 'utf8')
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let record: Json
    try {
      record = JSON.parse(line) as Json
    } catch {
      throw new StoreError('log_corrupt', `unreadable record in ${logPath}`)
    }
    if (!isRec(record)) throw new StoreError('log_corrupt', `malformed record in ${logPath}`)
    const seq = record['s']
    if (typeof seq === 'number' && seq > store.seq) store.seq = seq
    const op = record['op']
    const key = record['k']
    if (typeof key !== 'string') continue
    if (op === 'put') store.values.set(key, record['v'] ?? null)
    else if (op === 'del') store.values.delete(key)
  }
}

function readVersion(dir: string): number {
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return 0
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as Json
    if (isRec(parsed) && typeof parsed['version'] === 'number' && Number.isInteger(parsed['version'])) {
      return parsed['version']
    }
  } catch {
    // 元数据损坏：按版本 0 处理，让迁移重跑（幂等步骤不覆盖数据）
  }
  return 0
}

function writeVersion(dir: string, version: number): void {
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ version })}\n`)
}

function openOwner(root: string, owner: string): OwnerStore {
  const dir = join(root, owner)
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'log.jsonl')
  dropTornTail(logPath)
  const store: OwnerStore = { dir, logPath, fd: -1, version: 0, values: new Map(), seq: 0 }
  replay(logPath, store)
  store.version = readVersion(dir)
  for (const migration of MIGRATIONS) {
    if (migration.version <= store.version) continue
    migration.up(store)
    store.version = migration.version
  }
  if (store.version !== readVersion(dir)) writeVersion(dir, store.version)
  store.fd = openSync(logPath, 'a')
  return store
}

function appendRecords(store: OwnerStore, records: Json[]): void {
  const payload = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  writeSync(store.fd, payload)
  fsyncSync(store.fd)
}

/** 每个 owner 一个子目录 + 追加日志；`dataDir` 由宿主经 `CHRONO_PLUGIN_DATA` 注入。 */
export class KvEngine {
  private readonly root: string | null
  private readonly stores = new Map<string, OwnerStore>()

  constructor(dataDir: string | null) {
    this.root = dataDir
  }

  private store(owner: string): OwnerStore {
    const cached = this.stores.get(owner)
    if (cached !== undefined) return cached
    if (this.root === null) {
      throw new StoreError('no_data_dir', 'CHRONO_PLUGIN_DATA is not set; declare state: durable')
    }
    const store = openOwner(this.root, owner)
    this.stores.set(owner, store)
    return store
  }

  put(owner: string, args: Rec): Json {
    const key = requireKey(args['key'])
    const value = requireValue(args['value'])
    const store = this.store(owner)
    const seq = store.seq + 1
    appendRecords(store, [{ s: seq, op: 'put', k: key, v: value }])
    store.seq = seq
    store.values.set(key, value)
    return { ok: true, seq }
  }

  get(owner: string, args: Rec): Json {
    const key = requireKey(args['key'])
    const store = this.store(owner)
    const found = store.values.has(key)
    return { found, value: found ? (store.values.get(key) as Json) : null }
  }

  delete(owner: string, args: Rec): Json {
    const key = requireKey(args['key'])
    const store = this.store(owner)
    if (!store.values.has(key)) return { deleted: false }
    const seq = store.seq + 1
    appendRecords(store, [{ s: seq, op: 'del', k: key }])
    store.seq = seq
    store.values.delete(key)
    return { deleted: true }
  }

  list(owner: string, args: Rec): Json {
    const prefix = args['prefix']
    if (prefix !== undefined && typeof prefix !== 'string') {
      throw new BadArgsError('prefix must be a string')
    }
    const store = this.store(owner)
    const entries = [...store.values.entries()]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value }))
    return { entries }
  }

  batch(owner: string, args: Rec): Json {
    const ops = args['ops']
    if (!Array.isArray(ops) || ops.length === 0) throw new BadArgsError('ops must be a non-empty array')
    const store = this.store(owner)
    const records: Json[] = []
    const applied: Array<{ op: 'put' | 'del'; key: string; value: Json }> = []
    let seq = store.seq
    for (let index = 0; index < ops.length; index += 1) {
      const item = ops[index]
      if (!isRec(item)) throw new BadArgsError(`ops[${index}] must be an object`)
      const op = item['op']
      const key = requireKey(item['key'])
      if (op === 'put') {
        const value = requireValue(item['value'])
        seq += 1
        records.push({ s: seq, op: 'put', k: key, v: value })
        applied.push({ op: 'put', key, value })
      } else if (op === 'del' || op === 'delete') {
        seq += 1
        records.push({ s: seq, op: 'del', k: key })
        applied.push({ op: 'del', key, value: null })
      } else {
        throw new BadArgsError(`ops[${index}].op must be 'put' or 'del'`)
      }
    }
    appendRecords(store, records)
    for (const entry of applied) {
      if (entry.op === 'put') store.values.set(entry.key, entry.value)
      else store.values.delete(entry.key)
    }
    store.seq = seq
    return { ok: true, count: records.length }
  }

  info(owner: string): Json {
    const store = this.store(owner)
    return { schemaVersion: store.version, entries: store.values.size }
  }

  /** 丢弃本 owner 的命名空间：关闭句柄并删除其子目录；宿主不认识命名空间语义，不代劳。 */
  dropNamespace(owner: string): Json {
    const store = this.store(owner)
    const dropped = store.values.size
    closeSync(store.fd)
    this.stores.delete(owner)
    rmSync(store.dir, { recursive: true, force: true })
    return { dropped }
  }

  /** 断连 / drain：关闭全部句柄，已 fsync 的记录不受影响。 */
  close(): void {
    for (const store of this.stores.values()) {
      try {
        closeSync(store.fd)
      } catch {
        // 关闭失败不阻断退出
      }
    }
    this.stores.clear()
  }
}
