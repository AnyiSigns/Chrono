// 机械闸入口：本地复刻 #33 机械闸 dry-run（闭合 / 类型 / publish 偏序 / 端口 ⊆ pins +
// 六条图不变量 + 四条演化规则），返回错误列表与结果哈希。**不 eff #33**（#33 只有 interpret，不提供 validate）。
// 已知实现重复：权威以 #33 写期机械闸为准；规则换代时本副本的一致性对拍为待办（见 README）。

import { buildView, checkClosure, checkPortsPinned, checkPublishOrder, checkTypes, gateError } from './closure.ts'
import type { GateError } from './closure.ts'
import { checkEvolution, checkInvariants } from './invariants.ts'
import { H } from './hash.ts'
import { readGraphModel } from './model.ts'
import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

export interface ValidateResult {
  ok: boolean
  errors: GateError[]
  result_hash: string
}

/** 校验输入的规范化哈希口径：对 `{graph, pins, active_graph, runs_since_fork}` 做内核口径 H。 */
export function validateHashInput(bag: Rec): Json {
  return {
    graph: bag['graph'] === undefined ? null : bag['graph'],
    pins: isRecord(bag['pins']) ? bag['pins'] : {},
    active_graph: isRecord(bag['active_graph']) ? bag['active_graph'] : null,
    runs_since_fork: typeof bag['runs_since_fork'] === 'number' ? bag['runs_since_fork'] : null,
  }
}

/** 对一个 bag 跑完整机械闸 dry-run（list / read / validate / propose 共用同一口径）。 */
export function validateBag(bag: Rec): ValidateResult {
  const resultHash = H(validateHashInput(bag))
  const model = readGraphModel(bag['graph'])
  if (model === null) {
    return { ok: false, errors: [gateError('graph_missing', 'graph', '缺图数据（bag.graph）')], result_hash: resultHash }
  }
  const pins = isRecord(bag['pins']) ? bag['pins'] : {}
  const activeGraph = isRecord(bag['active_graph']) ? bag['active_graph'] : null
  const runsSinceFork = typeof bag['runs_since_fork'] === 'number' ? bag['runs_since_fork'] : null
  const view = buildView(model)
  const errors: GateError[] = [
    ...checkClosure(view),
    ...checkTypes(view),
    ...checkPublishOrder(view),
    ...checkPortsPinned(view, pins),
    ...checkInvariants(view),
    ...checkEvolution(view, activeGraph, runsSinceFork),
  ]
  return { ok: errors.length === 0, errors, result_hash: resultHash }
}
