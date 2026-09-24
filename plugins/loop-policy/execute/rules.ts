// 服务内声明式规则求值器（种子判定 / pre / post / when）：只做结构检查与谓词求值。
// `when` 入参 = 上游产出 + 状态摘要；`post` 输入面 = 本 Scope outputs/inputs/reads + thresholds + 本步 eff_log。
// 规则名住数据世代；求值逻辑住 execute（改判定 = 换代，服务自驱既定代价）。

import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 规则求值上下文（解释器逐步构造）。 */
export interface RuleCtx {
  nodeIndex: number
  outputs: Map<number, Rec>
  inputs: Map<number, Rec>
  shared: Rec
  thresholds: Rec
  state: Rec
  effLog: Json[]
}

export interface RuleResult {
  ok: boolean
  code?: string
  reason?: string
}

/** 非空判定：字符串 / 数组 / 对象 / 数值。 */
export function nonempty(value: Json | undefined): boolean {
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

/** 裁决值：优先 `verdict`，其次 `decision`，再次输出本身为字符串。 */
function verdictValue(ctx: RuleCtx, sourceNode: number): string | null {
  const output = ctx.outputs.get(sourceNode)
  if (output === undefined) return null
  for (const key of ['verdict', 'decision', 'status']) {
    const value = output[key]
    if (typeof value === 'string') return value
  }
  return null
}

/** 解析 `name` 或 `name(args)`。 */
function parseRule(expr: string): { name: string; args: string } {
  const text = expr.trim()
  const open = text.indexOf('(')
  if (open < 0 || !text.endsWith(')')) return { name: text, args: '' }
  return { name: text.slice(0, open).trim(), args: text.slice(open + 1, -1).trim() }
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
export function wroteFiles(results: Json | undefined, calls: Rec[], tools: Json | undefined): boolean {
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

/** 待办未完成：items 里有 pending / in_progress。 */
export function todoIncomplete(todo: Json | undefined): boolean {
  const items: Json[] = []
  const collect = (value: Json | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) items.push(item)
      return
    }
    if (isRecord(value)) {
      if (Array.isArray(value['items'])) for (const item of value['items']) items.push(item)
      const conversations = value['conversations']
      if (isRecord(conversations)) {
        for (const entry of Object.values(conversations)) collect(entry)
      }
    }
  }
  collect(todo)
  for (const item of items) {
    if (!isRecord(item)) continue
    const status = item['status']
    if (status === 'pending' || status === 'in_progress') return true
  }
  return false
}

function stateFlag(ctx: RuleCtx, key: string): boolean {
  return ctx.state[key] === true
}

/** `when` 求值（缺省空串 = 无条件）。 */
export function evalWhen(expr: string, ctx: RuleCtx, sourceNode: number): boolean {
  const text = expr.trim()
  if (text.length === 0) return true
  if (text.startsWith('not ')) return !evalWhen(text.slice(4), ctx, sourceNode)
  const { name, args } = parseRule(text)
  switch (name) {
    case 'nonempty':
      return nonempty(outputField(ctx, sourceNode, args))
    case 'empty':
      return !nonempty(outputField(ctx, sourceNode, args))
    case 'eq': {
      const colon = args.indexOf(':')
      if (colon < 0) return false
      const field = args.slice(0, colon).trim()
      const expected = args.slice(colon + 1).trim()
      const value = outputField(ctx, sourceNode, field)
      return String(value ?? '') === expected
    }
    case 'verdict_is':
      return verdictValue(ctx, sourceNode) === args
    case 'wrote_files': {
      const results = outputField(ctx, sourceNode, args.length > 0 ? args : 'results')
      const calls = Array.isArray(ctx.state['last_calls']) ? (ctx.state['last_calls'] as Rec[]) : []
      return wroteFiles(results, calls, ctx.state['tools'])
    }
    case 'todo_incomplete':
      return stateFlag(ctx, 'todo_incomplete')
    case 'question_pending':
      return stateFlag(ctx, 'question_pending')
    case 'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete': {
      const dispatched = stateFlag(ctx, 'dispatched_tools')
      const question = stateFlag(ctx, 'question_pending')
      return (dispatched && !question) || stateFlag(ctx, 'verify_failed') || stateFlag(ctx, 'todo_incomplete')
    }
    default:
      return false
  }
}

/** `pre` 求值：未知规则 fail-closed（`pre_unsat`）。 */
export function evalPre(name: string, ctx: RuleCtx): RuleResult {
  switch (name) {
    case 'always':
      return { ok: true }
    case 'inputs_ready': {
      const inputs = ctx.inputs.get(ctx.nodeIndex) ?? {}
      return Object.keys(inputs).length > 0 ? { ok: true } : { ok: false, code: 'pre_unsat', reason: 'no_inputs' }
    }
    default:
      return { ok: false, code: 'pre_unsat', reason: `unknown_pre:${name}` }
  }
}

function asText(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** 模型 tool_calls 结构校验：name 非空串、args 是对象（或 arguments 可解析为对象）、call_id 不重复。 */
export function checkToolCalls(raw: Json | undefined): { ok: boolean; reason?: string; calls: Rec[] } {
  if (raw === undefined || raw === null) return { ok: true, calls: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed_tool_call', calls: [] }
  const calls: Rec[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      calls.push({ call_id: `__bad-${index}`, tool: '', args: {}, __bad: true })
      return
    }
    // 同时接受模型原始形状（name / id / arguments）与归一形状（tool / call_id / args）。
    const name = asText(item['name']) || asText(item['tool'])
    const callId = asText(item['id']) || asText(item['call_id']) || `call-${index}`
    // args 显式给出则必须是对象；否则回落模型原始 `arguments`（字符串 JSON 或对象）。
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
  return bad === undefined ? { ok: true, calls: calls.map(stripBad) } : { ok: false, reason: 'malformed_tool_call', calls }
}

function stripBad(call: Rec): Rec {
  const { __bad: _bad, ...rest } = call
  return rest
}

/** `post` 求值：只做结构检查，不查语义（读不到工具目录）。 */
export function evalPost(name: string, ctx: RuleCtx): RuleResult {
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
  // 同帧带前言正文与工具调用是常见模型行为（assistant content + tool_calls）：
  // 正文随 assistant 消息回灌（见 `stepOutput` / `appendToolMessages`），不视为结构非法。
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
