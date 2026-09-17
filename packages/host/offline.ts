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
  headOf,
  loadAnchor,
  readJournal,
  releaseLock,
  replayFull,
  verifyFull,
} from './ledger/index.ts'
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
    let anchor = loadAnchor(paths.journalFile)
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
          world: anchor.world,
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

/** 全量校验：抢锁后读整条日志校验，绝不静默读半条。 */
export function runVerify(root: string): VerifyReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    return verifyFull(readJournal(paths.journalFile))
  } finally {
    releaseLock(paths.lockFile)
  }
}

/** 全量重放：从空世界重建，给出链头与内容摘要。 */
export function runReplay(root: string): ReplayReport {
  const paths = hostPaths(root)
  const lock = acquireLock(paths.lockFile, Date.now())
  if (!lock.ok) throw new Error('writer_busy')
  try {
    const entries = readJournal(paths.journalFile)
    return { head: headOf(entries), worldRev: worldRev(replayFull(entries)) }
  } finally {
    releaseLock(paths.lockFile)
  }
}
