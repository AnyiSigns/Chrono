// 基础世界文件（G6）：快照位置 + 世界本体。
// 宿主侧派生缓存（③ 可重算）：丢了可由「冷段 + 尾段」全链重放重建；链上的 `snapshot` entry
// 只记凭证与位置、不携带本体（kernel.md §八），本体真源在宿主——这里。
//
// 落盘分两片（v2）：`base.json` 只存小索引（快照位置 / 摘要 / ids / def 哈希清单 / 分片参数），
// def body 按哈希前缀分片落 `defs/<gen>/<prefix>.jsonl`（每行一条 `{h,d}`）。读取时 defs 表是
// 惰性代理，只有真正取 body 才读分片——启动不再把整世界 body 读进内存。
// 写入先落分片代目录再原子换索引（半写安全）：崩溃只可能留下无人引用的代目录 / staging；
// 未变动的分片按内容直接复用，只重写新增 / 变化的前缀。
// 审计已迁旁路侧存（`state/audit/`），base 不再携带审计索引；老 base 的 `audits` 字段被忽略。
// 读侧：形态 / 内容摘要自校不符即 `bad_base`；分片目录整体缺失视作无基础世界（回落全链）。

import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson, defsKeys, worldRev } from '../../kernel/index.ts'
import type { Def, Hash, Json, World } from '../../kernel/index.ts'
import { fsyncDir, writeFileAtomic, writeFileStaged } from '../common/fs-atomic.ts'
import { isRecord } from '../common/json.ts'
import { DefStore, createLazyDefs } from './def-store.ts'

/** 当前基础世界格式版本（v2 = 索引 + 分片）。 */
export const BASE_VERSION = 2
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
  /**
   * 惰性内容自校：首次调用算 `worldRev` 并与记值比对，不符抛 `bad_base`；同进程内按
   * `(file, mtimeMs, size)` 缓存通过结果，重复读不重算。`readBase` 不再 eager 自校，
   * 校验点（`loadAnchor` 接驳）按需调用——正常路径本就需要摘要，行为等价。
   */
  verify: () => void
}

/**
 * 已通过自校的 base 文件缓存：每个文件只保留**最近一次**的 `(mtime, size) → worldRev`。
 * 文件每次重写（compact）都换新 mtime / size，只留最新一份即可，避免按内容累积的键无限增长。
 */
const verifiedBases = new Map<string, { key: string; rev: Hash }>()

/** 自校缓存标识：按文件 + mtime + size 判同一份内容；取不到 stat 则不用缓存（返回 null）。 */
function verifyKey(file: string): { file: string; key: string } | null {
  try {
    const stat = statSync(file)
    return { file, key: `${file}\u0000${stat.mtimeMs}\u0000${stat.size}` }
  } catch {
    return null
  }
}

/** 惰性自校闭包：命中缓存或算得摘要相符即通过，不符抛 `bad_base`。 */
function makeVerify(
  identity: { file: string; key: string } | null,
  world: World,
  expected: Hash,
): () => void {
  let verified = false
  return () => {
    if (verified) return
    if (identity !== null) {
      const cached = verifiedBases.get(identity.file)
      if (cached !== undefined && cached.key === identity.key && cached.rev === expected) {
        verified = true
        return
      }
    }
    let actual: Hash
    try {
      actual = worldRev(world)
    } catch {
      throw new Error('bad_base')
    }
    if (actual !== expected) throw new Error('bad_base')
    if (identity !== null) verifiedBases.set(identity.file, { key: identity.key, rev: expected })
    verified = true
  }
}

/**
 * 读基础世界文件；缺文件 / 分片目录整体缺失 → null；形态 / 内容自校不符 → 抛 `bad_base`。
 * 返回惰性 defs 表（读 body 才触发分片读）。老 base 携带的 `audits` 字段（审计曾进世界）被忽略：
 * 审计 def 已不再写 base，缺字段 / 空数组均合法。
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
  if (parsed['v'] === BASE_VERSION) return readSharded(file, parsed)
  throw new Error('bad_base')
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
  const world: World = { defs: createLazyDefs(store), ids: ids as unknown as World['ids'] }
  return {
    v: BASE_VERSION,
    snapshot: { seq: snapshot['seq'], hash: snapshot['hash'] },
    worldRev: parsed['worldRev'],
    ...(typeof snapshotRev === 'string' ? { snapshotRev } : {}),
    world,
    store,
    verify: makeVerify(verifyKey(file), world, parsed['worldRev']),
  }
}

/**
 * 原子写基础世界文件（v2：先落分片代目录，再原子换索引；随后清理旧代目录）。
 * `world_rev` 按实际落盘的 def 清单现算，不信调用方。
 * 未变动的分片（同前缀的键集与上一份 base 相同）直接复用旧分片文件，只重写变化的前缀，
 * 故不需要为整世界读取 body。`snapshotRev` = 快照 entry 记录的全量摘要（有界化回收 / 摘审计时由调用方传入）；
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
  const manifest = defsKeys(payload.world.defs).slice().sort()
  const { genId, written, rev } = writeDefShards(file, payload.world, manifest)
  const base = {
    v: BASE_VERSION,
    snapshot: payload.snapshot,
    worldRev: rev,
    snapshotRev: payload.snapshotRev ?? rev,
    ids,
    defs: written,
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

/** 按分片前缀分组 def 键（保持组内顺序，分组不改键集）。 */
function groupByPrefix(manifest: Hash[]): Map<string, Hash[]> {
  const byPrefix = new Map<string, Hash[]>()
  for (const hash of manifest) {
    const prefix = hash.slice(0, BASE_SHARD)
    const list = byPrefix.get(prefix)
    if (list === undefined) byPrefix.set(prefix, [hash])
    else list.push(hash)
  }
  return byPrefix
}

/** 上一份 base 的分片目录与逐前缀键集；缺文件 / 形态不符 / 目录缺失 → null（全量写）。 */
function previousShards(file: string): { dir: string; byPrefix: Map<string, Set<Hash>> } | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed['v'] !== BASE_VERSION) return null
    const defsDir = parsed['defsDir']
    const hashes = parsed['defs']
    if (typeof defsDir !== 'string' || !SHARD_REL.test(defsDir)) return null
    if (!Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string')) return null
    const dir = resolve(dirname(file), defsDir)
    if (!existsSync(dir)) return null
    const byPrefix = new Map<string, Set<Hash>>()
    for (const hash of hashes as Hash[]) {
      const prefix = hash.slice(0, BASE_SHARD)
      const set = byPrefix.get(prefix)
      if (set === undefined) byPrefix.set(prefix, new Set([hash]))
      else set.add(hash)
    }
    return { dir, byPrefix }
  } catch {
    return null
  }
}

/** 键集相等（无重复键，故长度 + 包含即等价）。 */
function sameSet(hashes: Hash[], other: ReadonlySet<Hash>): boolean {
  return hashes.length === other.size && hashes.every((hash) => other.has(hash))
}

/** 优先硬链接复用旧分片（同卷、省复制）；不支持时回退普通复制。 */
function linkOrCopy(src: string, dest: string): void {
  try {
    linkSync(src, dest)
  } catch {
    copyFileSync(src, dest)
  }
}

/**
 * 落 def 分片代目录：`<baseDir>/defs/<rev 前 16 位>/<prefix>.jsonl`。
 * 键集与上一份 base 相同的前缀直接复用其分片文件（不读 body）；其余前缀按需读 body 重写，
 * 取不到 body 的键（分片缺失等）不写、也不进索引清单，清单与分片保持一致。
 * 先写 staging 目录再整目录 rename（半写安全），崩溃只可能留下无人引用的 staging 目录。
 * @returns 代目录名、实际落盘的键清单与内容摘要
 */
function writeDefShards(
  file: string,
  world: World,
  manifest: Hash[],
): { genId: string; written: Hash[]; rev: Hash } {
  const root = join(dirname(file), SHARD_DIR)
  const previous = previousShards(file)
  const written: Hash[] = []
  const toWrite: [string, Hash[]][] = []
  const toLink: [string, string][] = []
  for (const [prefix, hashes] of groupByPrefix(manifest)) {
    const src = previous === null ? null : join(previous.dir, `${prefix}.jsonl`)
    const oldSet = previous?.byPrefix.get(prefix)
    if (src !== null && oldSet !== undefined && existsSync(src) && sameSet(hashes, oldSet)) {
      written.push(...hashes)
      toLink.push([src, prefix])
      continue
    }
    const kept = hashes.filter((hash) => world.defs[hash] !== undefined)
    if (kept.length > 0) toWrite.push([prefix, kept])
    written.push(...kept)
  }
  written.sort()
  const rev = worldRev({ defs: keysOnly(written), ids: world.ids })
  const genId = rev.slice(0, 16)
  const finalDir = join(root, genId)
  if (existsSync(finalDir)) return { genId, written, rev }
  mkdirSync(root, { recursive: true })
  const staging = join(root, `.staging-${genId}-${randomUUID()}`)
  mkdirSync(staging, { recursive: true })
  try {
    for (const [prefix, kept] of toWrite) {
      const lines = kept.map((hash) =>
        canonicalJson({ h: hash, d: world.defs[hash] as unknown as Json }),
      )
      // 批量写入：逐文件 fsync 保留（数据持久化不可省），目录 fsync 合并为 rename 后一次
      writeFileStaged(join(staging, `${prefix}.jsonl`), lines.join('\n') + '\n')
    }
    for (const [src, prefix] of toLink) linkOrCopy(src, join(staging, `${prefix}.jsonl`))
    fsyncDir(staging)
    if (existsSync(finalDir)) {
      rmSync(staging, { recursive: true, force: true })
      return { genId, written, rev }
    }
    renameSync(staging, finalDir)
    fsyncDir(root)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(finalDir)) return { genId, written, rev }
    throw err
  }
  return { genId, written, rev }
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
