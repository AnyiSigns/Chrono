// 回合尾写：trace 条目 + 新 evolution body 索引（一次写，世界增长 ∝ 回合数）。
// 只构造写计划；服务不写链。无 #43 台账（bag.evolution 缺失）时不产轨迹写。

import { H } from './hash.ts'
import { addGenOp, baseSeqOf, batchDirective, defHashOf, isRecord, putOp } from './plan.ts'
import { evolutionBody } from './proposals.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, Json, Rec } from './types.ts'

function hasLedger(bag: Rec): boolean {
  const evolution = bag['evolution']
  return isRecord(evolution)
}

function slotCount(body: Rec, kind: string): number {
  const slot = body[kind]
  if (!isRecord(slot)) return 0
  const count = slot['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
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

/** 构造回合尾 trace 写计划（batch）。 */
export function buildTraceTail(
  bag: Rec,
  trace: TraceRecorder,
  directives: Json[],
  env: CallEnv,
  graphHash: string | null,
  at: string,
): Json[] {
  if (!hasLedger(bag)) return []
  const body = evolutionBody(bag)
  const traceSlot = isRecord(body['trace']) ? (body['trace'] as Rec) : {}
  const prevTail = defHashOf(traceSlot['tail'])
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
  entry['prev'] = prevTail === null ? null : { def: prevTail }
  const newTrace: Rec = { tail: { def: { $n: 0 } }, count: slotCount(body, 'trace') + 1 }
  const ops: Json[] = [putOp(entry)]
  const base = baseSeqOf(bag['evolution'])
  if (base === null) {
    ops.push(
      putOp({
        ...body,
        version: typeof body['version'] === 'number' ? body['version'] : 1,
        trace: newTrace,
      }),
    )
  } else {
    // 补丁世代：只替换 trace 槽（version 缺失时补一条），不重写整份台账 body
    const patches: Json[] = []
    if (typeof body['version'] !== 'number') patches.push({ op: 'replace', path: ['version'], value: 1 })
    patches.push({ op: 'replace', path: ['trace'], value: newTrace })
    ops.push(putOp({ ops: patches }))
  }
  ops.push(addGenOp('evolution', 1, {}, base ?? undefined))
  return [batchDirective(ops)]
}
