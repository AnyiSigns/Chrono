// 历史审计一次性回填：把旧 base / journal 里的审计 def 导入旁路侧存（`state/audit/audit.jsonl`）。
// 背景：审计迁旁路侧存后，compact 机械摘除世界里的审计 def；升级前写入的审计 def 从未进侧存，
// `host.audit` 读不到。首启（或离线 compact）一次性扫描 base world defs 与冷段 / 尾段 entry 的
// `put` args，按 entry seq 升序重建记录追加进侧存，写 `state/audit/meta.json` 标记。
// 幂等：标记存在即跳过；回填受保留窗口约束（从新到旧取），超出部分不回填。
// 审计是旁路：不进世界、不进链、不参与重放。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Entry, Hash, Json, World } from '../kernel/index.ts'
import { AUDIT_MAX_BYTES, AUDIT_MAX_RECORDS } from './audit.ts'
import type { AuditDraft } from './audit.ts'
import { AuditStore } from './audit-store.ts'
import { EFFECT_AUDIT_KIND } from './effect/execute.ts'
import { writeFileAtomic } from './ledger/atomic.ts'
import type { HostPaths } from './paths.ts'

/** 回填标记：`backfilled` 为真即不再扫；`throughEntrySeq` = 本次回填覆盖到的最大 entry seq。 */
export interface AuditBackfillMeta {
  backfilled: boolean
  throughEntrySeq: number
}

export interface AuditBackfillOptions {
  /** 覆盖保留窗口条数（缺省 `AUDIT_MAX_RECORDS`）。 */
  maxRecords?: number
  /** 覆盖保留窗口近似字节（缺省 `AUDIT_MAX_BYTES`）。 */
  maxBytes?: number
}

export interface AuditBackfillReport {
  /** 本次实际追加的条数（已回填过则为 0）。 */
  backfilled: number
  /** 扫描覆盖到的最大 entry seq（无 entry 为 -1）。 */
  throughEntrySeq: number
}

function isRecord(value: unknown): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bodyBytes(body: Json): number {
  try {
    return JSON.stringify(body).length
  } catch {
    return 0
  }
}

/** 读回填标记；缺文件 / 形态坏 / 未标记一律视为未回填（fail-open，不砖化）。 */
export function readAuditBackfillMeta(file: string): AuditBackfillMeta | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed['backfilled'] !== true) return null
    const through = parsed['throughEntrySeq']
    return {
      backfilled: true,
      throughEntrySeq: typeof through === 'number' && Number.isFinite(through) ? through : -1,
    }
  } catch {
    return null
  }
}

function writeAuditBackfillMeta(file: string, meta: AuditBackfillMeta): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify(meta))
}

interface Candidate {
  seq: number
  at: number
  by: string
  body: Json
}

/**
 * 从 entry 的 `put` args 与 base world defs 收集审计 def。
 * entry 给出真实 `seq` / `at` / `by`；仅存于 base 而无 entry 的审计 def 以 `seq:-1, at:0, by:'host'`
 * 兜底（最旧，窗口裁剪时先被淘汰）。同 def 键以 entry 为准。
 */
function collectCandidates(world: World, entries: readonly Entry[]): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<Hash>()
  for (const entry of entries) {
    if (entry.op !== 'put') continue
    const args = isRecord(entry.args) ? entry.args : null
    const body = args?.['body']
    if (!isRecord(body) || body['kind'] !== EFFECT_AUDIT_KIND) continue
    if (typeof entry.argsHash === 'string') seen.add(entry.argsHash)
    candidates.push({
      seq: typeof entry.seq === 'number' ? entry.seq : -1,
      at: typeof entry.at === 'number' ? entry.at : 0,
      by: typeof entry.by === 'string' ? entry.by : 'host',
      body,
    })
  }
  for (const key of Object.keys(world.defs)) {
    if (seen.has(key)) continue
    const body = world.defs[key]?.body
    if (!isRecord(body) || body['kind'] !== EFFECT_AUDIT_KIND) continue
    candidates.push({ seq: -1, at: 0, by: 'host', body })
  }
  candidates.sort((a, b) => a.seq - b.seq)
  return candidates
}

/** 从新到旧取窗口内候选（条数 / 字节任一超限即停），返回时间正序的待追加草稿。 */
function selectWithinWindow(candidates: Candidate[], options: AuditBackfillOptions): AuditDraft[] {
  const maxRecords = options.maxRecords ?? AUDIT_MAX_RECORDS
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES
  const selected: Candidate[] = []
  let bytes = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]
    if (selected.length >= maxRecords) break
    const size = bodyBytes(candidate.body)
    if (selected.length > 0 && bytes + size > maxBytes) break
    selected.push(candidate)
    bytes += size
  }
  selected.reverse()
  return selected.map((candidate) => ({
    at: candidate.at,
    by: candidate.by,
    body: candidate.body,
  }))
}

/**
 * 一次性回填历史审计进侧存；已回填（`meta.json` 标记）则跳过。
 * @param paths 宿主路径（`auditFile` / `auditMetaFile`）
 * @param world 当前世界（扫 base world defs；缺 body 的键跳过）
 * @param entries 冷段 + 尾段全链 entry（给出真实 seq / at / by）
 * @param store 已打开的侧存（追加分配单调 seq，续 `nextSeq`）
 */
export function backfillAuditStore(
  paths: HostPaths,
  world: World,
  entries: readonly Entry[],
  store: AuditStore,
  options: AuditBackfillOptions = {},
): AuditBackfillReport {
  if (readAuditBackfillMeta(paths.auditMetaFile) !== null) {
    return { backfilled: 0, throughEntrySeq: -1 }
  }
  const throughEntrySeq = entries.length > 0 ? entries[entries.length - 1].seq : -1
  const drafts = selectWithinWindow(collectCandidates(world, entries), options)
  for (const draft of drafts) store.append(draft)
  writeAuditBackfillMeta(paths.auditMetaFile, { backfilled: true, throughEntrySeq })
  return { backfilled: drafts.length, throughEntrySeq }
}
