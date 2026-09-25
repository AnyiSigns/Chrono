// 离线命令：宿主未运行时的 seed / verify / replay。
// 与宿主进程互斥（同一把单写者锁）；seed 是宿主侧直写 commit 的入世路径。

import { randomUUID } from 'node:crypto'
import { statSync, truncateSync } from 'node:fs'
import { resolve } from 'node:path'
import { commit, worldRev } from '../kernel/index.ts'
import {
  gcMaterialized,
  latestDataGen,
  orderEntriesForSeed,
  planIngest,
  planPack,
  readPluginManifest,
} from './assembly/index.ts'
import type { MaterializedGcReport, PluginEntry } from './assembly/index.ts'
import {
  acquireLock,
  appendJournal,
  headOf,
  loadAnchor,
  readAllEntries,
  readJournal,
  releaseLock,
  repairJournalTail,
  replayFull,
  verifyFull,
} from './ledger/index.ts'
import type { Anchor } from './ledger/index.ts'
import { collectBlobRefs, gcBlobs, putBlob } from './blobs.ts'
import type { BlobGcReport } from './blobs.ts'
import { collectAssetRefs, gcAssets } from './assets.ts'
import type { AssetGcReport } from './assets.ts'
import { DEFAULT_FLATTEN_CHAIN, DEFAULT_GEN_RETENTION, compactWorld } from './compact.ts'
import { AuditStore } from './audit-store.ts'
import { backfillAuditStore, readAuditBackfillMeta } from './audit-backfill.ts'
import { hostPaths } from './paths.ts'
import type { HostPaths } from './paths.ts'
import type { Hash, Head, RecycleStats, WriteRequest } from '../kernel/index.ts'

/** 与 assembly 同源，保留本模块导出面（`readPluginManifest` 属插件清单读面）。 */
export { readPluginManifest }

export interface SeedItem {
  name: string
  status: 'seeded' | 'unchanged' | 'failed'
  identity?: string
  reasons: string[]
}

export interface SeedReport {
  ok: boolean
  items: SeedItem[]
  head: Head
}

export interface VerifyReport {
  ok: boolean
  error?: string
  head?: Head
  worldRev?: Hash
}

export interface ReplayReport {
  head: Head
  worldRev: Hash
}

/**
 * 持锁写命令在 append 前修复 journal 撕裂尾：容错读已丢弃末条半截 entry，
 * 这里把文件截到有效前缀，避免后续 append 把新 entry 粘在残行上（否则 journal 永久损坏）。
 */
function repairTruncatedJournal(paths: HostPaths, anchor: Anchor): void {
  if (anchor.journalTruncated) truncateSync(paths.journalFile, anchor.journalValidBytes)
}

/** 入世：按 pins 名级序（被依赖者先）逐个插件包构造原子 batch 并直写 commit；每个插件各自原子。 */
export function runSeed(root: string, explicit?: PluginEntry[]): SeedReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const entries = orderEntriesForSeed(root, explicit ?? readPluginManifest(root))
    let anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir, {
      migrateLegacy: true,
    })
    repairTruncatedJournal(paths, anchor)
    const items: SeedItem[] = []
    for (const entry of entries) {
      const planned = planIngest(anchor.world, root, entry)
      if (!planned.ok) {
        items.push({ name: entry.name, status: 'failed', reasons: planned.reasons })
        continue
      }
      const plan = planned.plan
      if (plan.unchanged) {
        items.push({ name: entry.name, status: 'unchanged', identity: plan.identity, reasons: [] })
        continue
      }
      const request: WriteRequest = {
        id: `seed-${randomUUID()}`,
        op: 'batch',
        target: { expect_pos: anchor.head.hash },
        args: { ops: plan.ops },
        by: 'seed',
      }
      // 字节先于链落 CAS：commit 拒绝时至多留孤儿字节（离线 GC 清理），世界分文未动
      for (const blob of plan.blobs) putBlob(paths.blobsDir, blob.bytes)
      const outcome = commit(anchor.head, anchor.world, request, Date.now())
      if (!outcome.verdict.ok) {
        items.push({ name: entry.name, status: 'failed', reasons: outcome.verdict.reasons })
        continue
      }
      if (outcome.entry !== null) {
        appendJournal(paths.journalFile, [outcome.entry])
        anchor = {
          ...anchor,
          head: { seq: outcome.entry.seq, hash: outcome.hash as Hash },
          entries: [...anchor.entries, outcome.entry],
        }
      }
      items.push({ name: entry.name, status: 'seeded', identity: plan.identity, reasons: [] })
    }
    return { ok: items.every((item) => item.status !== 'failed'), items, head: anchor.head }
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

export interface PackReport {
  ok: boolean
  identity: string
  status: 'packed' | 'unchanged' | 'failed'
  reasons: string[]
  commitHash?: Hash
  isNewIdentity?: boolean
  head: Head
}

/**
 * 手动 / 程序化入世单个目录（`boot pack`）：与 seed 共用同一打包核心，整包一条原子 batch 直写。
 * 身份不存在 → add_identity + add_gen；已存在 → 只 add_gen（不覆盖已有数据世代，只追加代码世代）。
 * 坏包（坏声明 / 缺 plugin.json / 缺 schema / .worldignore 非法 / 引脚未解析）整批拒绝、世界分文未动。
 */
export function runPack(root: string, dir: string, identity?: string): PackReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    let anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir, {
      migrateLegacy: true,
    })
    repairTruncatedJournal(paths, anchor)
    const planned = planPack(anchor.world, resolve(root, dir), identity, paths.blobsDir)
    if (!planned.ok) {
      return {
        ok: false,
        identity: identity ?? '',
        status: 'failed',
        reasons: planned.reasons,
        head: anchor.head,
      }
    }
    const plan = planned.plan
    if (plan.unchanged) {
      return {
        ok: true,
        identity: plan.identity,
        status: 'unchanged',
        reasons: [],
        commitHash: plan.commitHash,
        isNewIdentity: false,
        head: anchor.head,
      }
    }
    const request: WriteRequest = {
      id: `pack-${randomUUID()}`,
      op: 'batch',
      target: { expect_pos: anchor.head.hash },
      args: { ops: plan.ops },
      by: 'pack',
    }
    // 字节先于链落 CAS：commit 拒绝时至多留孤儿字节（离线 GC 清理），世界分文未动
    for (const blob of plan.blobs) putBlob(paths.blobsDir, blob.bytes)
    const outcome = commit(anchor.head, anchor.world, request, Date.now())
    if (!outcome.verdict.ok) {
      return {
        ok: false,
        identity: plan.identity,
        status: 'failed',
        reasons: outcome.verdict.reasons,
        head: anchor.head,
      }
    }
    if (outcome.entry !== null) {
      appendJournal(paths.journalFile, [outcome.entry])
      anchor = {
        ...anchor,
        head: { seq: outcome.entry.seq, hash: outcome.hash as Hash },
        entries: [...anchor.entries, outcome.entry],
      }
    }
    return {
      ok: true,
      identity: plan.identity,
      status: 'packed',
      reasons: [],
      commitHash: plan.commitHash,
      isNewIdentity: plan.isNewIdentity,
      head: anchor.head,
    }
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

/** 无锁只读的并发容忍：宿主 append 与读并发时撕裂尾由容错读丢弃；短退避重试等写者落定。 */
const UNSEEDED_READ_ATTEMPTS = 3
const UNSEEDED_READ_BACKOFF_MS = 20

function journalSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 同步短睡：`unseededIdentities` 是同步只读入口，退避不能走 await。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 无锁读锚点：读前读后比对 journal 大小，不一致说明宿主正在 append，短退避重试；
 * 有上限后按最后一次读取结果返回（撕裂尾已由 `loadAnchor` 的容错读丢弃，无锁只读不修复文件）。
 */
function loadAnchorStable(paths: HostPaths): Anchor {
  for (let attempt = 0; ; attempt++) {
    const before = journalSize(paths.journalFile)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    if (before === journalSize(paths.journalFile) || attempt >= UNSEEDED_READ_ATTEMPTS - 1) {
      return anchor
    }
    sleepSync(UNSEEDED_READ_BACKOFF_MS)
  }
}

/**
 * 只读列出「无数据世代」的身份（首启预置默认 body 的判据）：**不取写锁**，宿主运行时亦可读。
 * 宿主持世界单写者锁、日志 append-only，读侧只用于判定「该身份是否已有数据世代」。
 */
export function unseededIdentities(root: string): string[] {
  const paths = hostPaths(resolve(root))
  const anchor = loadAnchorStable(paths)
  const ids: string[] = []
  for (const id of Object.keys(anchor.world.ids)) {
    if (latestDataGen(anchor.world, id) === null) ids.push(id)
  }
  return ids.sort()
}

/** 全量校验：抢锁后读整条日志（冷段 + 尾段）校验，绝不静默读半条。 */
export function runVerify(root: string): VerifyReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    return verifyFull(readAllEntries(paths.journalFile, paths.coldDir))
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

/**
 * 资产回收（G4）：离线持锁，机械扫描世界里的 `kind:'asset'` 引用，
 * 删除资产区中「世界无引用」的字节；返回被删清单与保留数。
 * 世界是引用真源；只动 64-hex 命名的资产文件。
 */
export function runAssetGc(root: string): AssetGcReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const world = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).world
    return gcAssets(paths.assetsDir, collectAssetRefs(world))
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

/**
 * 源码 blob 可达性回收（④ 不可重算）：离线持锁，删世界**全部世代**无引用的 CAS 字节。
 * 与 `assets gc` 同规不在启动时自动跑；入世被拒但已落盘的孤儿字节由此清理。
 */
export function runBlobGc(root: string): BlobGcReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const world = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).world
    return gcBlobs(paths.blobsDir, collectBlobRefs(world))
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

/**
 * 物化目录回收（③ 可重算）：离线持锁，按每身份 active 代码世代 + 前 N 代保留；
 * 其余目录删除后仍可由「指针 def + CAS 字节」重建。
 */
export function runMaterializedGc(root: string): MaterializedGcReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const world = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir).world
    return gcMaterialized(paths.materializedDir, world)
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

/** 全量重放（冷段 + 尾段）：从空世界重建，给出链头与内容摘要。 */
export function runReplay(root: string): ReplayReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const entries = readAllEntries(paths.journalFile, paths.coldDir)
    return { head: headOf(entries), worldRev: worldRev(replayFull(entries)) }
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}

export interface CompactReport {
  snapshot: { seq: number; hash: Hash }
  moved: number
  recycled: RecycleStats
}

export interface CompactOptions {
  /**
   * 严格回收：不在保留闭包内的一律回收（含孤儿 def）。仅离线 / 显式启用，默认保守。
   * 仅在世界未使用 `{"def":hash}` 标记之外的哈希引用（引用图完备）时安全。
   */
  strict?: boolean
}

/** 压缩（G6）：全链重放一次 → 追加快照 entry + 冷段归档 + 有界化回收 + 基础世界落盘。 */
export function runCompact(root: string, options: CompactOptions = {}): CompactReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    // 压缩是写命令：先修复撕裂尾（截到有效前缀），再按严格读取全链，否则末条半截会让全链读抛错
    repairJournalTail(paths.journalFile)
    // world / head 按全链算；归档前缀只取当前 journal（未归档部分）——否则会把旧冷段再归档一遍
    const entries = readAllEntries(paths.journalFile, paths.coldDir)
    const world = replayFull(entries)
    // D2 历史审计一次性回填（与宿主首启同路，持锁时执行）：旁路失败不阻断压缩；已回填则跳过
    if (readAuditBackfillMeta(paths.auditMetaFile) === null) {
      try {
        backfillAuditStore(paths, world, entries, AuditStore.open(paths.auditFile))
      } catch {
        // 回填失败只损失历史审计可见性，下次压缩 / 启动再试
      }
    }
    const prefix = readJournal(paths.journalFile)
    const result = compactWorld(paths, world, headOf(entries), prefix, Date.now(), {
      genWindow: DEFAULT_GEN_RETENTION,
      flattenChain: DEFAULT_FLATTEN_CHAIN,
      strict: options.strict === true,
    })
    return {
      snapshot: result.snapshot,
      moved: result.moved,
      recycled: result.recycled,
    }
  } finally {
    releaseLock(paths.lockFile, lock.info)
  }
}
