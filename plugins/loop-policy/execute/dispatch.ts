// 节点派发：按契约 / 实例 / 输入构造各能力类的 bag，经反向调用 `port.call` 派发（发出者 = loop-policy）。
// 节点实现不在本插件（节点是各插件的 eff）；本文件只做 bag 装配、结果归一、模型失败时的降级判定。

import { resolveDowngrade } from './downgrade.ts'
import { displayParts } from './commit-parts.ts'
import {
  contractId,
  effectsMethods,
  effectsPorts,
  nodeBindings,
  nodeEntry,
  type GraphModel,
} from './model.ts'
import { checkToolCalls } from './rules.ts'
import { asArray, asString, isRecord, putOp } from './plan.ts'
import type { ChosenInstance } from './scope.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, Json, PortCaller, Rec, RunState } from './types.ts'

export interface NodeDispatchInput {
  nodeIndex: number
  iter: number
  contract: Rec
  instance: ChosenInstance
  inputs: Rec
  bag: Rec
  model: GraphModel
  pins: Rec
  rs: RunState
  env: CallEnv
  port: PortCaller
  trace: TraceRecorder
}

export interface NodeDispatchResult {
  ok: boolean
  value: Json
  outcome: 'ok' | 'error' | 'transport_failed'
  code?: string
}

/** 派发目标：优先节点 `entry`，否则契约 effects 的首个端口 / 方法。 */
function target(contract: Rec, instance: ChosenInstance): { cap: string; method: string } {
  const entry = nodeEntry(instance.node)
  if (entry !== null) {
    const cap = asString(entry['cap'])
    const method = asString(entry['method'])
    if (cap !== null && method !== null) return { cap, method }
  }
  const ports = effectsPorts(contract)
  const methods = effectsMethods(contract)
  return { cap: ports[0] ?? '', method: methods[0] ?? 'invoke' }
}

function pick(bag: Rec, keys: string[]): Rec {
  const out: Rec = {}
  for (const key of keys) if (bag[key] !== undefined) out[key] = bag[key]
  return out
}

/** 上下文组装的 bag：系统提示词 / 人格 / 技能 / 记忆 / 会话 + 本轮 iter 间产物。 */
function assembleBag(input: NodeDispatchInput): Rec {
  const bag = input.bag
  const out = pick(bag, [
    'config',
    'input',
    'memories',
    'session',
    'style',
    'skills',
    'recall',
    'tools',
    'thread_kind',
    'thread',
    'workspace_root',
    'tier',
    'persona',
    'skills_select',
  ])
  const system = input.model.prompts['system']
  if (isRecord(system) && typeof system['text'] === 'string') out['system_prompt'] = system['text']
  else if (bag['system_prompt'] !== undefined) out['system_prompt'] = bag['system_prompt']
  if (input.rs.extraMessages.length > 0) out['extra_messages'] = input.rs.extraMessages
  return out
}

/** 模型调用的 bag（agent.step / subagent / evolve.propose 共用）。 */
function modelBag(input: NodeDispatchInput): Rec {
  const bag = input.bag
  const messages = input.inputs['messages']
  const out: Rec = {
    config: bag['config'] ?? null,
    messages: Array.isArray(messages) ? messages : input.rs.messages,
  }
  if (Array.isArray(bag['tools'])) out['tools'] = bag['tools']
  if (bag['resilience'] !== undefined) out['resilience'] = bag['resilience']
  if (bag['tool_choice'] !== undefined) out['tool_choice'] = bag['tool_choice']
  return out
}

/** 工具门禁 bag：按 call 逐项判（整批）。 */
function gateBag(input: NodeDispatchInput): Rec {
  const calls = Array.isArray(input.rs.lastCalls) ? input.rs.lastCalls : []
  return {
    calls: calls.map((call) => ({ port: call['port'] ?? '', tool: call['tool'] ?? '', args: call['args'] ?? {} })),
    tier: input.bag['tier'] ?? null,
    workspace_root: input.bag['workspace_root'] ?? null,
    guard_rules: input.bag['guard_rules'] ?? null,
  }
}

function dispatchBag(input: NodeDispatchInput, verdict: Json | null): Rec {
  const bag = input.bag
  const out = pick(bag, [
    'tools',
    'tools_bindings',
    'mcp_tools',
    'directory',
    'projection_reads',
    'sandbox_tiers',
    'guard_rules',
    'workspace_root',
    'tier',
    'grant',
    'question',
  ])
  out['calls'] = Array.isArray(input.rs.lastCalls) ? input.rs.lastCalls : []
  if (verdict !== null) out['verdicts'] = verdict
  if (input.bag['cursor'] !== undefined) out['cursor'] = input.bag['cursor']
  return out
}

/** 整批汇总取最严：any deny → deny；否则 any escalate → escalate；否则 allow。 */
function strictest(judgeValue: Json): string {
  if (isRecord(judgeValue) && Array.isArray(judgeValue['decisions'])) {
    let result = 'allow'
    for (const decision of judgeValue['decisions'] as Json[]) {
      const verdict = isRecord(decision) && typeof decision['verdict'] === 'string' ? (decision['verdict'] as string) : 'deny'
      if (verdict === 'deny') return 'deny'
      if (verdict === 'escalate') result = 'escalate'
    }
    return result
  }
  if (isRecord(judgeValue) && typeof judgeValue['summary'] === 'string') return judgeValue['summary'] as string
  return 'allow'
}

/** 归一 agent.step / subagent 输出：补 `message` 与规范化 `tool_calls`。 */
function stepOutput(value: Json): Rec {
  const raw = isRecord(value) ? value : {}
  const text = typeof raw['text'] === 'string' ? (raw['text'] as string) : ''
  const checked = checkToolCalls(raw['tool_calls'])
  const message: Rec = { role: 'assistant', content: text }
  // 推理随承接帧携带，供回合落盘时作展示段；context-window 只取 role / parts / tool_calls，
  // 该字段不参与模型上下文（见 commit-parts.ts 头注）。
  if (typeof raw['reasoning'] === 'string' && (raw['reasoning'] as string).length > 0) {
    message['reasoning'] = raw['reasoning']
  }
  if (isRecord(raw['usage'])) message['usage'] = raw['usage']
  // 工具调用回灌：assistant 消息须带上本轮 tool_calls（中性形状 {id,name,arguments}），
  // 否则下一 iter 模型看不到自己的调用，会反复重调同一工具（协议层按方言编形）。
  if (checked.calls.length > 0) {
    message['tool_calls'] = checked.calls.map((call) => ({
      id: call['call_id'],
      name: call['tool'],
      arguments: call['args'] ?? {},
    }))
  }
  return { ...raw, message, tool_calls: checked.calls }
}

/** 归一模型 tool_calls → 派发 calls（{call_id, tool, args}）；用于 gate / dispatch。 */
export function toCalls(value: Json): Rec[] {
  const checked = checkToolCalls(isRecord(value) ? value['tool_calls'] : undefined)
  return checked.calls.map((call, index) => {
    const id = typeof call['call_id'] === 'string' ? call['call_id'] : `call-${index}`
    const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
    const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
    return { call_id: id, tool, args, port: providerOf(tool) }
  })
}

/** 工具 → 提供者能力类（供 guard 判据 (port, tool)）；缺目录信息时回落 `tool`。 */
let toolProviderLookup: (name: string) => string | null = () => null
export function setToolProviderLookup(fn: (name: string) => string | null): void {
  toolProviderLookup = fn
}
function providerOf(tool: string): string {
  return toolProviderLookup(tool) ?? 'tool'
}

/** 从 `bag.tools`（工具目录）建立工具 → 提供者能力类映射（供 guard 判据 (port, tool)）。 */
export function configureProviders(bag: Rec): void {
  const tools = bag['tools']
  const map = new Map<string, string>()
  if (Array.isArray(tools)) {
    for (const item of tools) {
      if (!isRecord(item)) continue
      const name = asString(item['name'])
      const provider = asString(item['provider'])
      if (name !== null && provider !== null) map.set(name, provider)
    }
  }
  setToolProviderLookup((name) => map.get(name) ?? null)
}

/**
 * `context.assemble` 前置：调用方未预置工具目录时经 `port.call` #27 `list` 取目录，
 * 写进 `bag.tools`（模型上下文可见）与 `bag.directory`（`tool.dispatch` 复用同一目录，不再现场重建）。
 * 目录已解析（调用方预置 / 本轮已取）即复用；`list` 传输失败按空目录处理，不阻断组装。
 */
async function ensureToolDirectory(input: NodeDispatchInput): Promise<void> {
  const bag = input.bag
  if ((Array.isArray(bag['tools']) && bag['tools'].length > 0) || isRecord(bag['directory'])) {
    configureProviders(bag)
    return
  }
  const listBag = pick(bag, ['tools_bindings', 'mcp_tools'])
  const outcome = await input.port.call('tools', 'list', listBag)
  const value = outcome.ok ? outcome.value : null
  const tools = isRecord(value) && Array.isArray(value['tools']) ? (value['tools'] as Json[]) : []
  const rejected = isRecord(value) && Array.isArray(value['rejected']) ? (value['rejected'] as Json[]) : []
  bag['tools'] = tools
  bag['directory'] = { tools, rejected }
  input.trace.recordEff(input.iter, 'tools', 'list', listBag, value, outcome.ok ? 'ok' : 'transport_failed')
  configureProviders(bag)
}

/** verify 的 dispatch 结果 → `{report:{passed, detail, exit_code}}`（post / trace 的输入面）。 */
function verifyOutput(value: Json): Rec {
  const results = isRecord(value) && Array.isArray(value['results']) ? (value['results'] as Json[]) : []
  const first = results.find((item): item is Rec => isRecord(item))
  if (first === undefined) return { passed: false, detail: 'no verify result', exit_code: null }
  if (first['ok'] !== true) {
    const error = isRecord(first['error']) ? (first['error'] as Rec) : {}
    return { passed: false, detail: String(error['message'] ?? error['code'] ?? 'verify failed'), exit_code: null }
  }
  const inner = isRecord(first['result']) ? (first['result'] as Rec) : {}
  if (typeof inner['passed'] === 'boolean') {
    return {
      passed: inner['passed'],
      detail: typeof inner['detail'] === 'string' ? inner['detail'] : '',
      exit_code: typeof inner['exit_code'] === 'number' ? inner['exit_code'] : null,
    }
  }
  return { passed: true, detail: typeof inner['detail'] === 'string' ? inner['detail'] : 'ok', exit_code: null }
}

function verifyBag(input: NodeDispatchInput): { bag: Rec; skipped: boolean } {
  const bindings = nodeBindings(input.instance.node)
  const command = asString(bindings['command']) ?? asString(bindings['verify_command']) ?? asString(bindings['tools'])
  if (command === null) return { bag: {}, skipped: true }
  const out = pick(input.bag, ['workspace_root', 'tier', 'guard_rules', 'tools', 'tools_bindings', 'projection_reads'])
  out['calls'] = [{ call_id: 'verify-0', tool: 'shell', args: { command }, port: 'tool-shell' }]
  return { bag: out, skipped: false }
}

function commitBag(input: NodeDispatchInput): Rec {
  const bag = input.bag
  const session = isRecord(bag['session']) ? (bag['session'] as Rec) : {}
  const slots = isRecord(bag['slots']) ? (bag['slots'] as Rec) : isRecord(bag['input_body']) ? (bag['input_body'] as Rec) : {}
  const inputValue = bag['input']
  const slot = isRecord(inputValue) && typeof inputValue['kind'] === 'string' ? inputValue : { kind: 'chat.message', text: asString(isRecord(inputValue) ? inputValue['content'] : undefined) ?? '' }
  const userText = asString(isRecord(inputValue) ? inputValue['text'] ?? inputValue['content'] : undefined) ?? ''
  const message = isRecord(input.inputs['message']) ? (input.inputs['message'] as Rec) : {}
  const refusal = isRecord(input.inputs['refusal']) ? (input.inputs['refusal'] as Rec) : null
  const assistant: Rec = { content: typeof message['content'] === 'string' ? message['content'] : '' }
  if (isRecord(message['usage'])) assistant['meta'] = { usage: message['usage'] }
  // 展示 parts：推理 / 正文 / 工具卡按到达序落盘，定稿后 UI 仍能渲染工具卡与推理块。
  // 纯文本回合不写 parts（content 已覆盖），避免历史无谓膨胀。
  const parts = displayParts(
    input.rs.extraMessages,
    message,
    Array.isArray(bag['tools']) ? (bag['tools'] as Json[]) : [],
  )
  if (parts.some((part) => isRecord(part) && part['type'] !== 'text')) assistant['parts'] = parts
  const out: Rec = {
    session,
    slots,
    thread_id: input.env.thread ?? '_main',
    slot,
    user: { content: userText },
    assistant,
  }
  if (typeof session['current'] === 'string') out['conversation'] = session['current']
  // 无当前会话的自动建会话规格（由 chat 装配）：随 commit 透传给 session 原子建 main 会话。
  if (isRecord(bag['new_conversation'])) out['new_conversation'] = bag['new_conversation']
  // 落盘错误码取稳定拒绝码（`pre_unsat` / `capability_mismatch` …），不取内部 reason 明细：
  // 明细（如 `last_message_role`）只进 trace，UI 按码取人话。
  if (refusal !== null) out['error'] = asString(refusal['code']) ?? asString(refusal['message']) ?? 'refused'
  return out
}

/** 派发一个节点；返回归一结果（不抛，失败作数据）。 */
export async function dispatchNode(input: NodeDispatchInput): Promise<NodeDispatchResult> {
  const contractIdValue = contractId(input.contract) ?? ''
  const { cap, method } = target(input.contract, input.instance)

  if (contractIdValue === 'join') {
    return { ok: true, value: joinOutput(input), outcome: 'ok' }
  }
  if (contractIdValue === 'verify') {
    const prepared = verifyBag(input)
    if (prepared.skipped) return { ok: true, value: { report: { skipped: true } }, outcome: 'ok' }
    const result = await callPort(input, 'tools', 'dispatch', prepared.bag, false)
    if (!result.ok) return result
    return { ...result, value: { report: verifyOutput(result.value) } }
  }
  if (contractIdValue === 'tool.gate') {
    return callPort(input, 'guard', 'judge', gateBag(input), false)
  }
  if (contractIdValue === 'approval.wait') {
    return callPort(input, 'approval', 'enqueue', approvalBag(input), false)
  }
  if (contractIdValue === 'tool.dispatch') {
    return callPort(input, 'tools', 'dispatch', dispatchBag(input, input.inputs['verdict'] ?? null), false)
  }
  if (contractIdValue === 'turn.commit') {
    return callPort(input, 'session', 'commit', commitBag(input), false)
  }
  if (contractIdValue === 'context.assemble') {
    await ensureToolDirectory(input)
    return callPort(input, 'context', 'build', assembleBag(input), false)
  }
  if (contractIdValue === 'recall') {
    const out = pick(input.bag, ['workspace_id', 'budget'])
    out['query'] = input.bag['task'] ?? null
    return callPort(input, 'retrieval', 'search', out, false)
  }
  if (cap.length === 0) {
    return { ok: true, value: {}, outcome: 'ok' }
  }
  const bag = modelBag(input)
  const isModel = effectsPorts(input.contract).includes('model') || cap === 'model'
  return callPort(input, cap, method, bag, isModel)
}

/** join：纯函数（同键取最新），不发 eff。 */
function joinOutput(input: NodeDispatchInput): Json {
  const merged: Rec = {}
  for (const key of ['left', 'right']) {
    const value = input.inputs[key]
    if (isRecord(value)) for (const [k, v] of Object.entries(value)) merged[k] = v
  }
  return { merged }
}

function approvalBag(input: NodeDispatchInput): Rec {
  const bag = input.bag
  const queue = isRecord(bag['approval']) && isRecord((bag['approval'] as Rec)['queue']) ? (bag['approval'] as Rec)['queue'] : bag['queue']
  const refs = isRecord(bag['approval']) && isRecord((bag['approval'] as Rec)['refs']) ? (bag['approval'] as Rec)['refs'] : bag['refs']
  const escalated = escalatedCall(input)
  const port = escalated === null ? 'tool' : escalated.port
  const tool = escalated === null ? '' : escalated.tool
  const out: Rec = {
    kind: approvalKind(port, tool),
    port,
    queue: queue ?? null,
    refs: refs ?? {},
    cursor: input.bag['cursor'] ?? null,
    thread: input.env.thread,
    run: input.env.run,
    tier: bag['tier'] ?? null,
    workspace_id: bag['workspace_id'] ?? null,
    args_ref: { summary: tool.length > 0 ? `tool escalation: ${tool}` : 'tool escalation' },
  }
  return out
}

/**
 * 取触发升级的 call（(port, 工具名) 判据来源）：`tool.gate` 的逐项 decisions 由 gate 节点产出，
 * 经边只传出 `verdict` 字符串，故从派发前游标快照的 outputs 里读 gate 的 decisions；
 * 读不到时回落批内首个 call（v1 整批升级取最严）。
 */
function escalatedCall(input: NodeDispatchInput): { port: string; tool: string } | null {
  const decisions = decisionsFromRequest(input.inputs['request']) ?? decisionsFromCursor(input.bag['cursor'])
  if (decisions !== null) {
    for (const decision of decisions) {
      if (isRecord(decision) && decision['verdict'] === 'escalate') {
        return { port: asString(decision['port']) ?? 'tool', tool: asString(decision['tool']) ?? '' }
      }
    }
  }
  const call = (Array.isArray(input.rs.lastCalls) ? input.rs.lastCalls : []).find((item) => isRecord(item))
  if (call !== undefined) return { port: asString(call['port']) ?? 'tool', tool: asString(call['tool']) ?? '' }
  return null
}

function decisionsFromRequest(value: Json): Json[] | null {
  if (isRecord(value) && Array.isArray(value['decisions'])) return value['decisions'] as Json[]
  return null
}

function decisionsFromCursor(cursor: Json): Json[] | null {
  if (!isRecord(cursor) || !isRecord(cursor['outputs'])) return null
  for (const output of Object.values(cursor['outputs'] as Rec)) {
    const decisions = decisionsFromRequest(output)
    if (decisions !== null) return decisions
  }
  return null
}

/** 审批项 kind 判据 = (port, 工具名)：编排提案 → `orchestration_change`，插件写 → `plugin_write`，其余 `tool_call`。 */
function approvalKind(port: string, tool: string): string {
  if (tool === 'orchestration.propose' || port === 'orchestration-admin') return 'orchestration_change'
  if (tool === 'plugin.write' || port === 'plugin-admin') return 'plugin_write'
  return 'tool_call'
}

/**
 * 反向调用 + eff_log 记录 + 模型失败降级。
 * `transport_failed` 是唯一进 refusal 的派发失败；节点业务错误原样作值（调用方判定）。
 */
async function callPort(
  input: NodeDispatchInput,
  cap: string,
  method: string,
  bag: Rec,
  isModel: boolean,
): Promise<NodeDispatchResult> {
  const outcome = await input.port.call(cap, method, bag)
  if (!outcome.ok) {
    input.trace.recordEff(input.iter, cap, method, bag, { code: outcome.code }, 'transport_failed')
    return { ok: false, value: { ok: false, error: { code: 'transport_failed', message: outcome.message } }, outcome: 'transport_failed', code: 'transport_failed' }
  }
  const value = outcome.value
  const isError = isRecord(value) && value['ok'] === false
  input.trace.recordEff(input.iter, cap, method, bag, value, isError ? 'error' : 'ok')
  if (!isError) {
    return { ok: true, value: normalizeValue(cap, method, value), outcome: 'ok' }
  }
  const error = isRecord(value['error']) ? (value['error'] as Rec) : {}
  const code = asString(error['code']) ?? 'downstream_refusal'
  if (isModel) {
    const downgraded = await resolveDowngrade(input.port, input.pins, input.model.thresholds, code, cap)
    if (downgraded !== null) {
      const retry = await input.port.call(downgraded.port, method, bag)
      if (retry.ok && !(isRecord(retry.value) && retry.value['ok'] === false)) {
        input.trace.recordEff(input.iter, downgraded.port, method, bag, retry.value, 'ok')
        return { ok: true, value: normalizeValue(downgraded.port, method, retry.value), outcome: 'ok' }
      }
      input.trace.recordEff(input.iter, downgraded.port, method, bag, retry.ok ? retry.value : { code: retry.code }, retry.ok ? 'error' : 'transport_failed')
    }
  }
  return { ok: false, value, outcome: 'error', code }
}

function normalizeValue(cap: string, method: string, value: Json): Json {
  if (cap === 'model' && method === 'chat') return stepOutput(value)
  if (cap === 'guard' && method === 'judge') {
    return isRecord(value) ? { ...value, verdict: strictest(value) } : { decisions: [], summary: { allow: 0, escalate: 0, deny: 0 }, verdict: 'allow' }
  }
  if (cap === 'approval' && method === 'enqueue') {
    return isRecord(value) ? { ...value, decision: 'pending' } : value
  }
  return value
}

/** 从 tool.dispatch 的 results 里挑出成功项（供 wrote_files / extra_messages）。 */
export function successfulResults(value: Json): Rec[] {
  const results = isRecord(value) ? asArray(value['results']) : null
  if (results === null) return []
  return results.filter((item): item is Rec => isRecord(item) && item['ok'] === true)
}

/** 组装提交计划的占位辅助（供 dispatch 单测引用）。 */
export function dummyPut(body: Json): Json {
  return putOp(body)
}
