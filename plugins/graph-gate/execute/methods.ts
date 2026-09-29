// 能力类 `graph-gate` 的方法表：validate / closure / select / hash。
// 图数据随 args 传入（服务不读投影、无写通道、不发 eff）；重逻辑全部住本提供方。
// - validate：完整机械闸（闭合 / 类型 / publish 偏序 / 端口 ⊆ pins + 六不变量 + 四演化规则）；
// - closure：运行期结构闭合（未知契约 + 闭合检查）；- select：实例确定性选择；- hash：内核口径内容哈希。

import { BadArgsError, asString, isRecord } from 'plugin-sdk'
import { runtimeClosure, validateGraphData, type ValidateInput } from './gate.ts'
import { H } from './hash.ts'
import { selectInstance } from './scope.ts'
import { readGraphModel } from './model.ts'
import type { Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

function refsOf(args: Rec): Rec {
  return isRecord(args['refs']) ? (args['refs'] as Rec) : {}
}

/** 从 args 取机械闸入参（缺 `pins` 回落空、缺 `active_graph` 回落 null）。 */
function validateInputOf(args: Rec): ValidateInput {
  return {
    graph: args['graph'] === undefined ? null : args['graph'],
    pins: isRecord(args['pins']) ? (args['pins'] as Rec) : {},
    active_graph: isRecord(args['active_graph']) ? (args['active_graph'] as Rec) : null,
    runs_since_fork:
      typeof args['runs_since_fork'] === 'number' ? (args['runs_since_fork'] as number) : null,
    refs: refsOf(args),
  }
}

/** 完整机械闸：回错误列表与结果哈希（与拆分前逐字节一致）。 */
function validate(args: Json): Json {
  return validateGraphData(validateInputOf(requireRecord(args)))
}

/** 运行期结构闭合：回错误列表与拓扑视图（廉价校验，供解释器入口用）。 */
function closure(args: Json): Json {
  const parsed = requireRecord(args)
  const result = runtimeClosure(parsed['graph'], refsOf(parsed))
  return { ok: result.ok, errors: result.errors, view: result.view }
}

/** 实例确定性选择：按 workspace / session 过滤 + tie-break 取首。 */
function select(args: Json): Json {
  const parsed = requireRecord(args)
  const model = readGraphModel(parsed['graph'], refsOf(parsed))
  if (model === null)
    return { ok: false, error: { code: 'graph_missing', message: '缺图数据（bag.graph）' } }
  const contractId = asString(parsed['contract_id'])
  if (contractId === null) throw new BadArgsError('contract_id required')
  const contract = model.contracts.find((item) => item['contract_id'] === contractId) ?? null
  if (contract === null) {
    return {
      ok: false,
      error: { code: 'contract_not_found', message: `契约未声明：${contractId}` },
    }
  }
  const scopeCtx = {
    workspace_id: asString(parsed['workspace_id']),
    session_id: asString(parsed['session_id']),
  }
  return { ok: true, instance: selectInstance(model, contract, scopeCtx) }
}

/** 内核口径内容哈希：对 args.value 做 H。 */
function hash(args: Json): Json {
  const parsed = requireRecord(args)
  if (!Object.hasOwn(parsed, 'value')) throw new BadArgsError('value required')
  return { hash: H(parsed['value']) }
}

/** 构造方法表（纯函数，无依赖注入）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    validate: (args: Json): HandlerResult => ({ value: validate(args), events: [] }),
    closure: (args: Json): HandlerResult => ({ value: closure(args), events: [] }),
    select: (args: Json): HandlerResult => ({ value: select(args), events: [] }),
    hash: (args: Json): HandlerResult => ({ value: hash(args), events: [] }),
  }
}
