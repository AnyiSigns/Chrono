// 压缩（G6）：追加快照 entry（自校 `world_rev`）+ 前缀冷段归档 + 尾段 journal 重写 + 基础世界落盘。
// 内核零改动：只用 `snapshot` op 的自校、`replay(entries, from)`、`worldRev`。
// 这是宿主第三处直写（与审计、seed 同类）：压缩由宿主在持锁时发起，不走 run / directive。

import { randomUUID } from 'node:crypto'
import { commit, worldRev } from '../kernel/index.ts'
import type { Entry, Hash, Head, World } from '../kernel/index.ts'
import { archiveColdSegment, writeBase, writeJournalAtomic } from './ledger/index.ts'
import type { BaseAuditRef } from './ledger/index.ts'
import type { HostPaths } from './paths.ts'

/** 启动自动压缩阈值（尾段 entry 数）：达到即追加快照并归档前缀。 */
export const DEFAULT_COMPACT_TAIL_ENTRIES = 512

export interface CompactResult {
  snapshot: { seq: number; hash: Hash }
  moved: number
}

/**
 * 在 `head` 处追加快照 entry，把 `prefix`（快照前的 entry）归档为冷段，
 * journal 重写为「快照 entry 起的尾段」，并写基础世界文件。
 * 快照 entry 的 `args.world_rev` 由 applyEntry 自校；`world` 按引用就地演化（快照不改世界）。
 */
export function compactWorld(
  paths: HostPaths,
  world: World,
  head: Head,
  prefix: Entry[],
  audits: BaseAuditRef[],
  now: number,
): CompactResult {
  const request = {
    id: `snapshot-${randomUUID()}`,
    op: 'snapshot' as const,
    target: { expect_pos: head.hash },
    args: { world_rev: worldRev(world) },
    by: 'host',
  }
  const outcome = commit(head, world, request, now)
  if (!outcome.verdict.ok || outcome.entry === null || outcome.hash === null) {
    throw new Error(`compact_failed: ${outcome.verdict.reasons.join(',')}`)
  }
  const snapshotEntry = outcome.entry
  const snapshot = { seq: snapshotEntry.seq, hash: outcome.hash as Hash }
  // 先归档前缀、再重写 journal：任何一步崩掉都不丢 entry（冷段已落盘）
  archiveColdSegment(paths.coldDir, prefix)
  writeJournalAtomic(paths.journalFile, [snapshotEntry])
  writeBase(paths.baseFile, { snapshot, world, audits })
  return { snapshot, moved: prefix.length }
}
