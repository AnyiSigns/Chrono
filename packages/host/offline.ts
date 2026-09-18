// 离线命令：宿主未运行时的 seed / verify / replay。
// 与宿主进程互斥（同一把单写者锁）；seed 是宿主侧直写 commit 的入世路径。

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { commit, worldRev } from '../kernel/index.ts'
import { planIngest } from './assembly/index.ts'
import type { PluginEntry } from './assembly/index.ts'
import {
  acquireLock,
  appendJournal,
  auditRefOf,
  headOf,
  loadAnchor,
  readAllEntries,
  readJournal,
  releaseLock,
  replayFull,
  verifyFull,
} from './ledger/index.ts'
import type { BaseAuditRef } from './ledger/index.ts'
import { auditRecordOf } from './audit.ts'
import { collectAssetRefs, gcAssets } from './assets.ts'
import type { AssetGcReport } from './assets.ts'
import { compactWorld } from './compact.ts'
import { hostPaths } from './paths.ts'
import type { Hash, Head, WriteRequest } from '../kernel/index.ts'

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

/** 读 `state/plugins.json`；缺文件即空清单。 */
export function readPluginManifest(root: string): PluginEntry[] {
  const file = hostPaths(root).pluginsFile
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('bad_plugins_manifest')
  return parsed.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('bad_plugins_manifest')
    const record = item as { name?: unknown; path?: unknown }
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error('bad_plugins_manifest')
    }
    return record.path === undefined
      ? { name: record.name }
      : { name: record.name, path: String(record.path) }
  })
}

/** 入世：逐个插件包构造原子 batch 并直写 commit；每个插件各自原子。 */
export function runSeed(root: string, explicit?: PluginEntry[]): SeedReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const entries = explicit ?? readPluginManifest(root)
    let anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
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
    releaseLock(paths.lockFile)
  }
}

/** 全量校验：抢锁后读整条日志（冷段 + 尾段）校验，绝不静默读半条。 */
export function runVerify(root: string): VerifyReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    return verifyFull(readAllEntries(paths.journalFile, paths.coldDir))
  } finally {
    releaseLock(paths.lockFile)
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
    releaseLock(paths.lockFile)
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
    releaseLock(paths.lockFile)
  }
}

export interface CompactReport {
  snapshot: { seq: number; hash: Hash }
  moved: number
  audits: number
}

/** 压缩（G6）：全链重放一次 → 追加快照 entry + 冷段归档 + 基础世界落盘。 */
export function runCompact(root: string): CompactReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    // world / head / 审计索引按全链算；归档前缀只取当前 journal（未归档部分）——否则会把旧冷段再归档一遍
    const entries = readAllEntries(paths.journalFile, paths.coldDir)
    const world = replayFull(entries)
    const audits: BaseAuditRef[] = []
    for (const entry of entries) {
      const record = auditRecordOf(entry)
      if (record !== null) audits.push(auditRefOf(record))
    }
    const prefix = readJournal(paths.journalFile)
    const result = compactWorld(paths, world, headOf(entries), prefix, audits, Date.now())
    return { ...result, audits: audits.length }
  } finally {
    releaseLock(paths.lockFile)
  }
}
