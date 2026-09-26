// 压缩（G6）：追加快照 entry（自校 `world_rev`）+ 前缀冷段归档 + 尾段 journal 重写 + 基础世界落盘。
// 内核零改动：只用 `snapshot` op 的自校、`replay(entries, from)`、`worldRev` 与 `recycleWorld`。
// 这是宿主第三处直写（与 seed 同类）：压缩由宿主在持锁时发起，不走 run / directive。
//
// 有界化（本文件）：写基础世界前，按可达性回收 def + 裁世代窗口（`recycleWorld`），
// 并机械摘除审计 def——审计已迁旁路侧存，不再是世界内容 / 世界根。
// 未达 def 与审计 def 不写进新 base；冷段归档保留历史，full verify（冷段 + 尾段从空世界重放）仍过。
// 回收失败 fail-open：退回未回收世界照常写盘，不阻断压缩。

import { randomUUID } from 'node:crypto'
import { recycleWorld, worldRev } from '../kernel/index.ts'
import type { Entry, Hash, Head, Json, RecycleStats, World } from '../kernel/index.ts'
import { archiveColdSegment, writeBase, writeJournalAtomic } from './ledger/index.ts'
import { commitToWorld } from './world-commit.ts'
import { isRecord } from './common/json.ts'
import { latestDataGen } from './assembly/index.ts'
import { reachableDefHashes } from './projection/index.ts'
import { EFFECT_AUDIT_KIND } from './audit.ts'
import type { HostPaths } from './paths.ts'

/** 启动自动压缩阈值（尾段 entry 数）：达到即追加快照并归档前缀。 */
export const DEFAULT_COMPACT_TAIL_ENTRIES = 512

/** 有界化缺省世代窗口：每身份保留最近 N 代（含 active）+ 被 pin / graft 引用的世代。 */
export const DEFAULT_GEN_RETENTION = 64

/** 缺省补丁链压扁阈值：线性补丁链长达到此值即在 compact 时折叠成整份世代。 */
export const DEFAULT_FLATTEN_CHAIN = 32

/** compact 时的有界化策略；缺省（未传）不按世代窗口回收，但仍摘除审计 def。 */
export interface CompactRetention {
  /** 世代保留窗口（<=0 = 不裁世代）。 */
  genWindow: number
  /** 严格模式：不在保留闭包内的一律回收（缺省保守，只回收窗口淘汰根独有者）。 */
  strict?: boolean
  /** 补丁链压扁阈值：>=2 时把线性补丁世代链折叠成整份世代（缩短链）。 */
  flattenChain?: number
  /** 显式额外保留世代（缺省由 `compactWorld` 按各身份最近定义数据世代算出）。 */
  keepGens?: { id: string; seq: number }[]
  /** 显式额外保留根（缺省由 `compactWorld` 算出定义数据世代 payload 及其闭包哈希）。 */
  keepRoots?: Hash[]
}

export interface CompactResult {
  snapshot: { seq: number; hash: Hash }
  moved: number
  recycled: RecycleStats
  /** 落盘的基础世界本体（有界化回收 + 摘审计后）：调用方须以它续写，保证内存世界与 base 一致。 */
  world: World
}

/**
 * 各身份最近数据世代的保留集：投影 `body` 取它（`projection/index.ts`），
 * 若其落在世代窗口外被裁，读侧会取到不完整闭包而落 `denied`，故 compact 恒保留。
 * 运行记录已出世界，世界里的数据世代只剩定义数据，故保留集只覆盖定义数据世代。
 * 只按身份机械枚举，不解释 body 语义。
 */
function dataGenKeepGens(world: World): { id: string; seq: number }[] {
  const out: { id: string; seq: number }[] = []
  for (const id of Object.keys(world.ids)) {
    const gen = latestDataGen(world, id)
    if (gen !== null) out.push({ id, seq: gen.seq })
  }
  return out
}

/**
 * 定义数据世代 payload + 其 `{"def":hash}` 闭包哈希：投影 `body` 及闭包恒在 base。
 * 补丁数据世代的 base 链由内核 `retainedGens` 沿 `base` 一并保留，其 payload 闭包同样覆盖。
 */
function dataGenKeepRoots(world: World): Hash[] {
  const roots = new Set<Hash>()
  for (const id of Object.keys(world.ids)) {
    const gen = latestDataGen(world, id)
    if (gen === null) continue
    roots.add(gen.payload)
    const body = world.defs[gen.payload]?.body
    if (body !== undefined) for (const hash of reachableDefHashes(world, body)) roots.add(hash)
  }
  return [...roots]
}

/** 回收（fail-open）：异常退回未回收世界，压缩照常。 */
function recycleOrKeep(
  world: World,
  retention: CompactRetention | undefined,
): { world: World; stats: RecycleStats } {
  const kept = { removedDefs: 0, droppedGens: 0, keptDefs: Object.keys(world.defs).length }
  if (retention === undefined) return { world, stats: kept }
  const flattening = retention.flattenChain !== undefined && retention.flattenChain >= 2
  if (retention.genWindow <= 0 && !flattening) return { world, stats: kept }
  try {
    return recycleWorld(world, {
      genWindow: retention.genWindow,
      strict: retention.strict === true,
      flattenChain: retention.flattenChain,
      keepGens: retention.keepGens ?? dataGenKeepGens(world),
      keepRoots: retention.keepRoots ?? dataGenKeepRoots(world),
    })
  } catch {
    return { world, stats: kept }
  }
}

/** 审计 def 判别：body 带保留判别键 `kind:'effect_audit'`。 */
function isAuditDef(body: Json | undefined): boolean {
  return isRecord(body) && body['kind'] === EFFECT_AUDIT_KIND
}

/**
 * 机械摘除审计 def：审计已迁旁路侧存，不再写进世界 / base。
 * 审计 def 从不被身份世代闭包引用（只被旧 journal entry 的 `ref` 指），摘除不产生悬挂；
 * 冷段 journal 仍留旧审计 entry，full verify 从空世界重放照常可寻址。
 */
function stripAuditDefs(world: World): World {
  let found = false
  for (const key of Object.keys(world.defs)) {
    if (isAuditDef(world.defs[key]?.body)) {
      found = true
      break
    }
  }
  if (!found) return world
  const defs: World['defs'] = {}
  for (const key of Object.keys(world.defs)) {
    if (isAuditDef(world.defs[key]?.body)) continue
    defs[key] = world.defs[key]
  }
  return { defs, ids: world.ids }
}

/**
 * 在 `head` 处追加快照 entry，把 `prefix`（快照前的 entry）归档为冷段，
 * journal 重写为「快照 entry 起的尾段」，并写基础世界文件。
 * 快照 entry 的 `args.world_rev` 由 applyEntry 自校（记录**全量**世界摘要，供 full verify）；
 * 基础世界本体可经有界化回收 / 摘审计变小（此时 `snapshotRev` 与基础 `worldRev` 不同，loadAnchor 跳过快照自校）。
 * @param retention 有界化策略；缺省不按世代窗口回收（审计 def 仍摘除）
 */
export function compactWorld(
  paths: HostPaths,
  world: World,
  head: Head,
  prefix: Entry[],
  now: number,
  retention?: CompactRetention,
): CompactResult {
  const snapshotRev = worldRev(world)
  const committed = commitToWorld(
    { kind: 'lock', world, head },
    {
      id: `snapshot-${randomUUID()}`,
      op: 'snapshot',
      args: { world_rev: snapshotRev },
      by: 'host',
    },
    now,
    (entry) => {
      // 先归档前缀、再重写 journal：任何一步崩掉都不丢 entry（冷段已落盘）
      archiveColdSegment(paths.coldDir, prefix)
      writeJournalAtomic(paths.journalFile, [entry])
    },
  )
  if (committed.kind !== 'committed') {
    const reason = committed.kind === 'refused' ? committed.reasons.join(',') : 'noop'
    throw new Error(`compact_failed: ${reason}`)
  }
  const snapshot = { seq: committed.entry.seq, hash: committed.hash }
  const recycled = recycleOrKeep(world, retention)
  const pruned = stripAuditDefs(recycled.world)
  writeBase(paths.baseFile, { snapshot, snapshotRev, world: pruned })
  return { snapshot, moved: prefix.length, recycled: recycled.stats, world: pruned }
}
