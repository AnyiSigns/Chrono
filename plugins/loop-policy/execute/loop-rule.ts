// `loop-rule` 拥有方 loop-policy 的内建默认规则库：图执行的条件 / 前置 / 后置判据按名在此实现。
// 消费方 graph-run 只按名求值、不再持有封闭词表；外部提供方经同一能力类补名规则。
// 求值上下文由调用方序列化随 args 传入（服务只收 bag、回结果），本模块不读投影、不 import 宿主。

import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 规则求值上下文（由 graph-run 的中立形状反序列化而来）。 */
export interface RuleCtx {
  nodeIndex: number
  outputs: Map<number, Rec>
  inputs: Map<number, Rec>
  shared: Rec
  thresholds: Rec
  state: Rec
  effLog: Json[]
}

/** `when` 求值结果：`ok:false` 是结构化拒绝（畸形判据），不是「条件不成立」。 */
export interface WhenResult {
  ok: boolean
  value: boolean
  reason?: string
}

/** `pre` / `post` 求值结果。 */
export interface RuleResult {
  ok: boolean
  reason?: string
}

/** 非空判定：字符串 / 数组 / 对象 / 数值。 */
function nonempty(value: Json | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

function outputField(ctx: RuleCtx, sourceNode: number, field: string): Json | undefined {
  const output = ctx.outputs.get(sourceNode)
  if (output === undefined) return undefined
  if (field.length === 0) {
    const keys = Object.keys(output)
    return keys.length === 1 ? output[keys[0]] : output
  }
  return output[field]
}

/** 裁决值：优先 `verdict`，其次 `decision`，再次 `status`。 */
function verdictValue(ctx: RuleCtx, sourceNode: number): string | null {
  const output = ctx.outputs.get(sourceNode)
  if (output === undefined) return null
  for (const key of ['verdict', 'decision', 'status']) {
    const value = output[key]
    if (typeof value === 'string') return value
  }
  return null
}

/** 工具声明表（bag.tools）→ 按名索引。 */
function toolIndex(tools: Json | undefined): Map<string, Rec> {
  const map = new Map<string, Rec>()
  if (Array.isArray(tools)) {
    for (const item of tools) {
      if (isRecord(item) && typeof item['name'] === 'string') map.set(item['name'], item)
    }
  }
  return map
}

const WRITE_TOOL_RE = /^(edit|write|apply|create|delete|move|mkdir|patch|shell|bash|exec)/i

/** 单工具是否写类：声明 caps.fs.write 非 none，或名字落在写类前缀。 */
function isWriteTool(name: string, tools: Json | undefined): boolean {
  const decl = toolIndex(tools).get(name)
  if (decl !== undefined) {
    const caps = isRecord(decl['caps']) ? decl['caps'] : {}
    const fs = isRecord(caps['fs']) ? caps['fs'] : {}
    if (fs['write'] !== undefined) return fs['write'] !== 'none'
  }
  return WRITE_TOOL_RE.test(name)
}

/**
 * `wrote_files(results)`：results 里有无**写类工具成功项**。
 * 写类判据 = 对应 call 的工具声明 caps.fs.write 非 none（或名字写类前缀）；
 * 无 calls 信息时保守回落：任一成功项带 `path`/`file`/`files` 字段即视为写。
 */
function wroteFiles(results: Json | undefined, calls: Rec[], tools: Json | undefined): boolean {
  if (!Array.isArray(results)) return false
  const byId = new Map<string, Rec>()
  calls.forEach((call, index) => {
    const id = typeof call['call_id'] === 'string' ? call['call_id'] : `call-${index}`
    byId.set(id, call)
  })
  let index = 0
  for (const result of results) {
    const rec = isRecord(result) ? result : null
    index += 1
    if (rec === null || rec['ok'] !== true) continue
    const id = typeof rec['call_id'] === 'string' ? (rec['call_id'] as string) : `call-${index - 1}`
    const call = byId.get(id)
    const tool = call !== undefined && typeof call['tool'] === 'string' ? (call['tool'] as string) : ''
    if (tool.length > 0) {
      if (isWriteTool(tool, tools)) return true
      continue
    }
    const value = rec['result']
    if (isRecord(value) && (value['path'] !== undefined || value['file'] !== undefined || value['files'] !== undefined)) {
      return true
    }
  }
  return false
}

function stateFlag(ctx: RuleCtx, key: string): boolean {
  return ctx.state[key] === true
}

/** 本能力类负责的判据名（供消费方按名发现）。 */
const WHEN_RULES = new Set([
  'nonempty',
  'empty',
  'eq',
  'verdict_is',
  'wrote_files',
  'todo_incomplete',
  'question_pending',
  'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete',
])

const PRE_RULES = new Set(['always', 'inputs_ready'])

const POST_RULES = new Set(['always', 'assemble_post', 'step_post', 'dispatch_post', 'verify_post'])

export function hasWhenRule(name: string): boolean {
  return WHEN_RULES.has(name)
}

export function hasPreRule(name: string): boolean {
  return PRE_RULES.has(name)
}

export function hasPostRule(name: string): boolean {
  return POST_RULES.has(name)
}

/** `when` 判据求值（缺省空串由调用方处理；`not` 前缀由调用方剥除）。 */
export function evalWhenRule(name: string, args: string, ctx: RuleCtx, sourceNode: number): WhenResult {
  switch (name) {
    case 'nonempty':
      return { ok: true, value: nonempty(outputField(ctx, sourceNode, args)) }
    case 'empty':
      return { ok: true, value: !nonempty(outputField(ctx, sourceNode, args)) }
    case 'eq': {
      const colon = args.indexOf(':')
      if (colon < 0) return { ok: false, value: false, reason: `bad_args:${name}` }
      const field = args.slice(0, colon).trim()
      const expected = args.slice(colon + 1).trim()
      const value = outputField(ctx, sourceNode, field)
      return { ok: true, value: String(value ?? '') === expected }
    }
    case 'verdict_is':
      return { ok: true, value: verdictValue(ctx, sourceNode) === args }
    case 'wrote_files': {
      const results = outputField(ctx, sourceNode, args.length > 0 ? args : 'results')
      const calls = Array.isArray(ctx.state['last_calls']) ? (ctx.state['last_calls'] as Rec[]) : []
      return { ok: true, value: wroteFiles(results, calls, ctx.state['tools']) }
    }
    case 'todo_incomplete':
      return { ok: true, value: stateFlag(ctx, 'todo_incomplete') }
    case 'question_pending':
      return { ok: true, value: stateFlag(ctx, 'question_pending') }
    case 'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete': {
      const dispatched = stateFlag(ctx, 'dispatched_tools')
      const question = stateFlag(ctx, 'question_pending')
      return { ok: true, value: (dispatched && !question) || stateFlag(ctx, 'verify_failed') || stateFlag(ctx, 'todo_incomplete') }
    }
    default:
      return { ok: false, value: false, reason: `unknown_when:${name}` }
  }
}

/** `pre` 求值：未知规则由消费方 fail-closed。 */
export function evalPreRule(name: string, ctx: RuleCtx): RuleResult {
  switch (name) {
    case 'always':
      return { ok: true }
    case 'inputs_ready': {
      const inputs = ctx.inputs.get(ctx.nodeIndex) ?? {}
      return Object.keys(inputs).length > 0 ? { ok: true } : { ok: false, reason: 'no_inputs' }
    }
    default:
      return { ok: false, reason: `unknown_pre:${name}` }
  }
}

function asText(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** 模型 tool_calls 结构校验：name 非空串、args 是对象（或 arguments 可解析为对象）、call_id 不重复。 */
function checkToolCalls(raw: Json | undefined): { ok: boolean; reason?: string; calls: Rec[] } {
  if (raw === undefined || raw === null) return { ok: true, calls: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed_tool_call', calls: [] }
  const calls: Rec[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      calls.push({ call_id: `__bad-${index}`, tool: '', args: {}, __bad: true })
      return
    }
    const name = asText(item['name']) || asText(item['tool'])
    const callId = asText(item['id']) || asText(item['call_id']) || `call-${index}`
    let args: Json
    if (item['args'] !== undefined && item['args'] !== null) {
      args = item['args']
    } else {
      const rawArgs = item['arguments']
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs) as Json
        } catch {
          args = null
        }
      } else if (isRecord(rawArgs)) {
        args = rawArgs
      } else {
        args = {}
      }
    }
    const bad = name.length === 0 || !isRecord(args) || seen.has(callId)
    if (!bad) seen.add(callId)
    calls.push({ call_id: callId, tool: name, args: isRecord(args) ? args : {}, __bad: bad })
  })
  const bad = calls.find((call) => call['__bad'] === true)
  return bad === undefined
    ? { ok: true, calls: calls.map((call) => ({ call_id: call['call_id'], tool: call['tool'], args: call['args'] })) }
    : { ok: false, reason: 'malformed_tool_call', calls }
}

/** `post` 求值：只做结构检查，不查语义（读不到工具目录）。 */
export function evalPostRule(name: string, ctx: RuleCtx): RuleResult {
  const output = ctx.outputs.get(ctx.nodeIndex) ?? {}
  switch (name) {
    case 'always':
      return { ok: true }
    case 'assemble_post':
      return assemblePost(output)
    case 'step_post':
      return stepPost(output)
    case 'dispatch_post':
      return dispatchPost(output, ctx.inputs.get(ctx.nodeIndex) ?? {})
    case 'verify_post':
      return verifyPost(output)
    default:
      return { ok: false, reason: `unknown_post:${name}` }
  }
}

function assemblePost(output: Rec): RuleResult {
  const messages = output['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'empty_messages' }
  }
  const last = messages[messages.length - 1]
  const role = isRecord(last) ? asText(last['role']) : ''
  if (role.length > 0 && role !== 'user' && role !== 'tool' && role !== 'system') {
    return { ok: false, reason: 'last_message_role' }
  }
  const params = output['params']
  if (params !== undefined && params !== null && !isRecord(params)) {
    return { ok: false, reason: 'bad_params' }
  }
  return { ok: true }
}

function stepPost(output: Rec): RuleResult {
  if (output['ok'] === false) return { ok: false, reason: 'error_value' }
  const text = asText(output['text'])
  const hasMessage = text.length > 0
  const rawCalls = output['tool_calls']
  const hasCalls = Array.isArray(rawCalls) && rawCalls.length > 0
  if (!hasMessage && !hasCalls) return { ok: false, reason: 'empty_output' }
  if (hasCalls) {
    const checked = checkToolCalls(rawCalls)
    if (!checked.ok) return { ok: false, reason: checked.reason ?? 'malformed_tool_call' }
  }
  return { ok: true }
}

function dispatchPost(output: Rec, input: Rec): RuleResult {
  const results = output['results']
  if (!Array.isArray(results)) return { ok: false, reason: 'no_results' }
  const calls = Array.isArray(input['calls']) ? (input['calls'] as Json[]) : null
  if (calls !== null && calls.length !== results.length) {
    return { ok: false, reason: 'result_count_mismatch' }
  }
  for (const result of results) {
    if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
      return { ok: false, reason: 'bad_result_item' }
    }
    if (result['ok'] === false) {
      const error = result['error']
      if (!isRecord(error) || asText(error['code']).length === 0) {
        return { ok: false, reason: 'failure_without_code' }
      }
    }
  }
  return { ok: true }
}

function verifyPost(output: Rec): RuleResult {
  const report = output['report']
  if (!isRecord(report)) return { ok: false, reason: 'no_report' }
  if (report['skipped'] === true) return { ok: true }
  if (typeof report['passed'] !== 'boolean') return { ok: false, reason: 'no_passed' }
  if (!Object.hasOwn(report, 'detail')) return { ok: false, reason: 'no_detail' }
  return { ok: true }
}

/** 反序列化消费方随 args 传来的中立求值上下文（数值键 Map 由对象还原）。 */
export function ruleCtxFromWire(value: Json | undefined): RuleCtx {
  const raw = isRecord(value) ? value : {}
  const outputs = new Map<number, Rec>()
  const inputs = new Map<number, Rec>()
  const loadMap = (source: Json | undefined, target: Map<number, Rec>): void => {
    if (!isRecord(source)) return
    for (const [key, entry] of Object.entries(source)) {
      if (isRecord(entry)) target.set(Number(key), entry)
    }
  }
  loadMap(raw['outputs'], outputs)
  loadMap(raw['inputs'], inputs)
  return {
    nodeIndex: typeof raw['node_index'] === 'number' ? raw['node_index'] : 0,
    outputs,
    inputs,
    shared: isRecord(raw['shared']) ? raw['shared'] : {},
    thresholds: isRecord(raw['thresholds']) ? raw['thresholds'] : {},
    state: isRecord(raw['state']) ? raw['state'] : {},
    effLog: Array.isArray(raw['eff_log']) ? raw['eff_log'] : [],
  }
}
