// 基础世界文件（G6）：快照位置 + 世界本体。
// 宿主侧派生缓存（③ 可重算）：丢了可由「冷段 + 尾段」全链重放重建；链上的 `snapshot` entry
// 只记凭证与位置、不携带本体（kernel.md §八），本体真源在宿主——这里。
//
// 落盘分两片（v2）：`base.json` 只存小索引（快照位置 / 摘要 / ids / def 哈希清单 / 分片参数），
// def body 按哈希前缀分片落 `defs/<gen>/<prefix>.jsonl`（每行一条 `{h,d}`）。读取时 defs 表是
// 惰性代理，只有真正取 body 才读分片——启动不再把整世界 body 读进内存。
// 写入先落分片代目录再原子换索引（半写安全）：崩溃只可能留下无人引用的代目录 / staging。
// 旧单文件 v1（body 内联在 `world`）仍可读（照读，下次 compact 自动升级为 v2），fail-open。
// 审计已迁旁路侧存（`state/audit/`），base 不再携带审计索引；老 base 的 `audits` 字段被忽略。
// 读侧：形态 / 内容摘要自校不符即 `bad_base`；分片目录整体缺失视作无基础世界（回落全链）。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson, defsKeys, worldRev } from '../../kernel/index.ts'
import type { Def, Hash, Json, World } from '../../kernel/index.ts'
import { writeFileAtomic } from './atomic.ts'
import { DefStore, createLazyDefs } from './def-store.ts'

/** 当前基础世界格式版本（v2 = 索引 + 分片）。 */
export const BASE_VERSION = 2
/** 旧单文件格式版本（body 内联 `world`）；读取兼容，写侧不再产出。 */
export const LEGACY_BASE_VERSION = 1
/** def 分片前缀长度（十六进制字符数）：2 → 最多 256 个分片文件。 */
export const BASE_SHARD = 2

const SHARD_DIR = 'defs'
const SHARD_REL = /^defs\/[0-9a-f]{16}$/
const GEN_NAME = /^[0-9a-f]{16}$/

export interface BaseFile {
  v: number
  snapshot: { seq: number; hash: Hash }
  /** 基础世界本体的内容摘要（有界化回收 / 摘审计后为**落盘世界**的摘要，用于自校）。 */
  worldRev: Hash
  /** 快照 entry 记录的全量 world_rev；有界化回收 / 摘审计使基础世界变小时与 `worldRev` 不同。 */
  snapshotRev?: Hash
  world: World
  /** v2 分片存储句柄（仅内存态；测试 / 诊断可读其加载统计）。旧格式无此字段。 */
  store?: DefStore
}

function isRecord(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读基础世界文件；缺文件 / 分片目录整体缺失 → null；形态 / 内容自校不符 → 抛 `bad_base`。
 * v1 内联世界照读；v2 索引 + 分片世界返回惰性 defs 表（读 body 才触发分片读）。
 * 老 base 携带的 `audits` 字段（审计曾进世界）被忽略：审计 def 已不再写 base，缺字段 / 空数组均合法。
 */
export function readBase(file: string): BaseFile | null {
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('bad_base')
  }
  if (!isRecord(parsed)) throw new Error('bad_base')
  if (parsed['v'] === LEGACY_BASE_VERSION) return readLegacy(parsed)
  if (parsed['v'] === BASE_VERSION) return readSharded(file, parsed)
  throw new Error('bad_base')
}

/** 旧单文件（v1）：body 内联在 `world`，整份读入；内容摘要自校不符即 `bad_base`。 */
function readLegacy(parsed: { [k: string]: unknown }): BaseFile {
  const snapshot = parsed['snapshot']
  const world = parsed['world']
  if (
    !isRecord(snapshot) ||
    typeof snapshot['seq'] !== 'number' ||
    typeof snapshot['hash'] !== 'string' ||
    !isRecord(world) ||
    !isRecord(world['defs']) ||
    !isRecord(world['ids']) ||
    typeof parsed['worldRev'] !== 'string'
  ) {
    throw new Error('bad_base')
  }
  const snapshotRev = parsed['snapshotRev']
  if (snapshotRev !== undefined && typeof snapshotRev !== 'string') throw new Error('bad_base')
  const base: BaseFile = {
    v: LEGACY_BASE_VERSION,
    snapshot: { seq: snapshot['seq'], hash: snapshot['hash'] },
    worldRev: parsed['worldRev'],
    ...(typeof snapshotRev === 'string' ? { snapshotRev } : {}),
    world: world as unknown as World,
  }
  selfCheck(base)
  return base
}

/** 分片（v2）：索引小文件 + `defs/<gen>/<prefix>.jsonl`；世界为惰性 defs 表。 */
function readSharded(file: string, parsed: { [k: string]: unknown }): BaseFile | null {
  const snapshot = parsed['snapshot']
  const ids = parsed['ids']
  const hashes = parsed['defs']
  const shard = parsed['shard']
  const defsDir = parsed['defsDir']
  if (
    !isRecord(snapshot) ||
    typeof snapshot['seq'] !== 'number' ||
    typeof snapshot['hash'] !== 'string' ||
    typeof parsed['worldRev'] !== 'string' ||
    !isRecord(ids) ||
    !Array.isArray(hashes) ||
    !hashes.every((hash) => typeof hash === 'string') ||
    typeof shard !== 'number' ||
    !Number.isInteger(shard) ||
    shard < 1 ||
    shard > 4 ||
    typeof defsDir !== 'string' ||
    !SHARD_REL.test(defsDir)
  ) {
    throw new Error('bad_base')
  }
  const snapshotRev = parsed['snapshotRev']
  if (snapshotRev !== undefined && typeof snapshotRev !== 'string') throw new Error('bad_base')
  const dir = resolve(dirname(file), defsDir)
  // 分片目录整体丢失（缓存被清）：视作无基础世界，回落全链重放，不砖化
  if (!existsSync(dir)) return null
  const store = new DefStore({ dir, shard, hashes: hashes as Hash[] })
  const base: BaseFile = {
    v: BASE_VERSION,
    snapshot: { seq: snapshot['seq'], hash: snapshot['hash'] },
    worldRev: parsed['worldRev'],
    ...(typeof snapshotRev === 'string' ? { snapshotRev } : {}),
    world: { defs: createLazyDefs(store), ids: ids as unknown as World['ids'] },
    store,
  }
  selfCheck(base)
  return base
}

/** 内容自校：世界本体须与记的 world_rev 一致（防半截 / 手改）；畸形 world 一律映射为 bad_base。 */
function selfCheck(base: BaseFile): void {
  try {
    if (worldRev(base.world) !== base.worldRev) throw new Error('bad_base')
  } catch {
    throw new Error('bad_base')
  }
}

/**
 * 原子写基础世界文件（v2：先落分片代目录，再原子换索引；随后清理旧代目录）。
 * `world_rev` 按实际落盘的 def 清单现算，不信调用方。
 * `snapshotRev` = 快照 entry 记录的全量摘要（有界化回收 / 摘审计时由调用方传入）；
 * 缺省回落为世界本体摘要（未回收时两者相同）。
 */
export function writeBase(
  file: string,
  payload: {
    snapshot: { seq: number; hash: Hash }
    world: World
    snapshotRev?: Hash
  },
): void {
  const ids = payload.world.ids
  // 实际可落盘的 def 清单：取不到 body 的键（分片缺失等）不写，清单与分片保持一致
  const manifest = defsKeys(payload.world.defs)
    .filter((hash) => payload.world.defs[hash] !== undefined)
    .sort()
  const rev = worldRev({ defs: keysOnly(manifest), ids })
  const genId = writeDefShards(dirname(file), payload.world, manifest, rev)
  const base = {
    v: BASE_VERSION,
    snapshot: payload.snapshot,
    worldRev: rev,
    snapshotRev: payload.snapshotRev ?? rev,
    ids,
    defs: manifest,
    shard: BASE_SHARD,
    defsDir: `${SHARD_DIR}/${genId}`,
  }
  writeFileAtomic(file, JSON.stringify(base))
  gcShardGenerations(join(dirname(file), SHARD_DIR), genId)
}

/** 只带键的空 def 表：给 `worldRev` 算「按清单」的摘要（worldRev 只吃键，不吃 body）。 */
function keysOnly(manifest: Hash[]): Record<Hash, Def> {
  const table: Record<Hash, Def> = {}
  for (const hash of manifest) table[hash] = undefined as unknown as Def
  return table
}

/**
 * 落 def 分片代目录：`<baseDir>/defs/<rev 前 16 位>/<prefix>.jsonl`。
 * 内容寻址：同摘要即同目录，已存在则直接复用。先写 staging 目录再整目录 rename（半写安全），
 * 崩溃只可能留下无人引用的 staging 目录。返回代目录名（genId）。
 */
function writeDefShards(baseDir: string, world: World, manifest: Hash[], rev: Hash): string {
  const root = join(baseDir, SHARD_DIR)
  const genId = rev.slice(0, 16)
  const finalDir = join(root, genId)
  if (existsSync(finalDir)) return genId
  mkdirSync(root, { recursive: true })
  const staging = join(root, `.staging-${genId}-${randomUUID()}`)
  mkdirSync(staging, { recursive: true })
  try {
    const byPrefix = new Map<string, Hash[]>()
    for (const hash of manifest) {
      const prefix = hash.slice(0, BASE_SHARD)
      const list = byPrefix.get(prefix)
      if (list === undefined) byPrefix.set(prefix, [hash])
      else list.push(hash)
    }
    for (const [prefix, hashes] of byPrefix) {
      const lines = hashes.map((hash) =>
        canonicalJson({ h: hash, d: world.defs[hash] as unknown as Json }),
      )
      writeFileAtomic(join(staging, `${prefix}.jsonl`), lines.join('\n') + '\n')
    }
    if (existsSync(finalDir)) {
      rmSync(staging, { recursive: true, force: true })
      return genId
    }
    renameSync(staging, finalDir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(finalDir)) return genId
    throw err
  }
  return genId
}

/** 清理旧分片代目录与 staging 残留（单写者下安全；尽力而为，失败不致命）。 */
function gcShardGenerations(root: string, keep: string): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    if (name === keep) continue
    if (!GEN_NAME.test(name) && !name.startsWith('.staging-')) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      // 旧代清理失败不致命：下次写入再试
    }
  }
}
