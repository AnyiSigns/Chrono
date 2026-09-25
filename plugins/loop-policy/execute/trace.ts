// 轨迹与 eff_log 记录：每步（节点派发 / guard / 审批入队等）记
// {step, iter, port, method, args_hash, result_hash, outcome}；回合尾随 trace 写入世界。
// eff_log 是 post dense 信号与 #44 shadow 配对的数据底座（反向调用不入世界审计）。

import { H } from './hash.ts'
import type { Json, Rec } from './types.ts'

export interface TraceMeta {
  run: string | null
  session: string | null
  workspace_id: string | null
  graph: string | null
}

/** 单次 interpret 的轨迹记录器（服务进程内状态，不落账；回合尾一次写）。 */
export class TraceRecorder {
  readonly steps: Rec[] = []
  readonly effLog: Rec[] = []
  readonly linkTaken: Rec[] = []
  branchNotTaken = 0
  refusedAt: Rec | null = null
  outcome = 'done'
  l1Maxed = false
  private stepSeq = 0

  nextStep(): number {
    this.stepSeq += 1
    return this.stepSeq
  }

  startStep(nodeIndex: number, iter: number, contractId: string, chosenInstance: string, chosenAgent: string | null): Rec {
    const step: Rec = {
      node_index: nodeIndex,
      iter,
      contract_id: contractId,
      chosen_instance: chosenInstance,
      chosen_agent: chosenAgent,
      verdict: 'pass',
      refusal: null,
      post_failed: null,
      l1_iters: 0,
      l1_maxed: false,
      verify: null,
      usage: null,
      eff_log: [],
    }
    this.steps.push(step)
    return step
  }

  /** 记一条 eff_log；返回其序号（step 字段）。 */
  recordEff(iter: number, port: string, method: string, args: Json, result: Json, outcome: string): number {
    const seq = this.nextStep()
    this.effLog.push({
      step: seq,
      iter,
      port,
      method,
      args_hash: safeHash(args),
      result_hash: safeHash(result),
      outcome,
    })
    return seq
  }

  /** 把 eff_log 条目挂到当前 step（便于 trace schema 的 steps[].eff_log）。 */
  attachEff(step: Rec, entries: Rec[]): void {
    const list = Array.isArray(step['eff_log']) ? (step['eff_log'] as Json[]) : []
    for (const entry of entries) list.push(entry)
    step['eff_log'] = list
  }

  refuse(nodeIndex: number, iter: number, code: string, attributableTo: string): void {
    this.refusedAt = { node_index: nodeIndex, iter, code, attributable_to: attributableTo }
    this.outcome = 'refused'
  }

  notTaken(count: number): void {
    this.branchNotTaken += Math.max(0, count)
  }

  link(from: number, toContract: string, reason: string): void {
    this.linkTaken.push({ from, to_contract: toContract, reason })
  }

  /** 构造 trace 条目 body（prev 由调用方补）；摘要以 `{def}` 引用传入（正文由调用方落成 def）。 */
  buildEntry(meta: TraceMeta, directivesSummary: Json, ctxSummary: Json, at: string): Rec {
    const lastEff = this.effLog.length > 0 ? this.effLog[this.effLog.length - 1] : null
    return {
      kind: 'trace',
      run: meta.run,
      session: meta.session,
      workspace_id: meta.workspace_id,
      graph: meta.graph,
      steps: this.steps,
      eff_log: this.effLog,
      directives_summary: directivesSummary,
      ctx_summary: ctxSummary,
      refused_at: this.refusedAt,
      branch_not_taken: this.branchNotTaken,
      link_taken: this.linkTaken,
      outcome: this.outcome,
      at,
      prev: null,
      last_eff: lastEff,
    }
  }
}

/** 哈希的容错包装：不可序列化时回空串（不炸本轮）。 */
export function safeHash(value: Json): string {
  try {
    return H(value)
  } catch {
    return ''
  }
}
