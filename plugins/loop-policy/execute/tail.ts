// 回合尾写：trace 条目登记进回合累积器（同回合与 verdicts 合并为单个世代）。
// 只登记写计划；服务不写链。无 #43 台账（bag.evolution 缺失）时不登记轨迹写。

import { H } from './hash.ts'
import { isRecord } from './plan.ts'
import type { RoundPatches } from './plan.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, Json, Rec } from './types.ts'

function hasLedger(bag: Rec): boolean {
  const evolution = bag['evolution']
  return isRecord(evolution)
}

function ctxSummary(bag: Rec): Json {
  const summary: Rec = {
    workspace_id: bag['workspace_id'] ?? null,
    thread: bag['thread'] ?? null,
    input: isRecord(bag['input']) ? (bag['input'] as Rec)['content'] ?? null : null,
    session: isRecord(bag['session']) ? (bag['session'] as Rec)['current'] ?? null : null,
  }
  try {
    return { def: H(summary) }
  } catch {
    return null
  }
}

/**
 * 登记回合尾 trace 条目：`prev` 由累积器串到回合初 tail（或本回合上一条 trace），
 * 槽位 `count` / `tail` 由累积器在 `finalize` 时修正。
 */
export function buildTraceTail(
  bag: Rec,
  trace: TraceRecorder,
  directives: Json[],
  env: CallEnv,
  graphHash: string | null,
  at: string,
  round: RoundPatches,
): void {
  if (!hasLedger(bag)) return
  const entry = trace.buildEntry(
    {
      run: env.run,
      session: isRecord(bag['session']) ? ((bag['session'] as Rec)['current'] as string | null) ?? null : null,
      workspace_id: typeof bag['workspace_id'] === 'string' ? (bag['workspace_id'] as string) : null,
      graph: graphHash,
    },
    directives,
    ctxSummary(bag),
    at,
  )
  round.stage('evolution', 'trace', entry)
}
