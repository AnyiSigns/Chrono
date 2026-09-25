// 回合尾写：trace 条目登记进回合累积器（同回合与 verdicts 合并为单个世代）。
// 只登记写计划；服务不写链。无 #43 台账（bag.evolution 缺失）时不登记轨迹写。
// 摘要（directives / ctx）按 schema 声明落成 def，条目里只存 `{def}` 引用——
// 不落 def 会留下悬空引用，投影闭包解析时 `def_unavailable`（chat 每回合都解析 evolution 闭包）。
// 摘要只留结构（kind / op / path / id 等），**不含消息正文**，避免轨迹重复存正文。

import { isRecord } from './plan.ts'
import type { RoundPatches } from './plan.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, Json, Rec } from './types.ts'

function hasLedger(bag: Rec): boolean {
  const evolution = bag['evolution']
  return isRecord(evolution)
}

/** 轮首投影 ctx 轻量摘要 body（影子回放数据载体；不含输入正文）。 */
function ctxSummaryBody(bag: Rec): Rec {
  return {
    workspace_id: bag['workspace_id'] ?? null,
    thread: bag['thread'] ?? null,
    session: isRecord(bag['session']) ? ((bag['session'] as Rec)['current'] ?? null) : null,
  }
}

/** 单条批内子操作的轻量摘要：只留 op / id / path，不带 body。 */
function summarizeOp(op: Json): Json {
  if (!isRecord(op)) return { op: null }
  const args = isRecord(op['args']) ? (op['args'] as Rec) : {}
  const summary: Rec = { op: op['op'] ?? null }
  if (typeof args['id'] === 'string') summary['id'] = args['id']
  if (Array.isArray(args['path'])) summary['path'] = args['path']
  return summary
}

/** 单条 directive 的轻量摘要：只留 kind / op / 子操作结构，不带 body 与 extern 载荷。 */
function summarizeDirective(directive: Json): Json {
  if (!isRecord(directive)) return { kind: null }
  const kind = directive['kind']
  if (kind === 'write' && isRecord(directive['request'])) {
    const request = directive['request'] as Rec
    const args = isRecord(request['args']) ? (request['args'] as Rec) : {}
    const subOps = Array.isArray(args['ops']) ? (args['ops'] as Json[]) : []
    return { kind: 'write', op: request['op'] ?? null, ops: subOps.map(summarizeOp) }
  }
  if (kind === 'eval') return { kind: 'eval', command: directive['command'] ?? null }
  return { kind }
}

/** 本次 run directives 的轻量摘要 body（不含正文）。 */
function directivesSummaryBody(directives: Json[]): Rec {
  const items = directives.map(summarizeDirective)
  return { count: items.length, items }
}

/** 登记摘要 def 并回 `{def}` 引用；不可序列化（哈希失败）回 null。 */
function summaryRef(round: RoundPatches, body: Json): Json {
  try {
    return { def: round.stageDef(body) }
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
    directives.length > 0 ? summaryRef(round, directivesSummaryBody(directives)) : null,
    summaryRef(round, ctxSummaryBody(bag)),
    at,
  )
  round.stage('evolution', 'trace', entry)
}
