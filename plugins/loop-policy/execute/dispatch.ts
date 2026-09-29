// 节点派发：按契约 / 实例 / 输入构造各能力类的 bag，经反向调用 `port.call` 派发（发出者 = loop-policy）。
// 节点实现不在本插件（节点是各插件的 eff）；本文件只做 bag 装配、结果归一、模型失败时的降级判定。

import { resolveDowngrade } from './downgrade.ts'
import { displayParts } from './commit-parts.ts'
import { isCancelled } from './cancel.ts'
import { latestCheckpoint, renderCheckpointText, subagentTaskText, toSubagentResult } from './subagent.ts'
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
import { appendStep, nextStepSeq } from './steplog.ts'
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
    // 回合身份随组装下传：context-window 据此把本轮用户消息保留为 P0 `input`、本轮其它记录归 `tool`（T0），
    // 不把本轮 user_message 投影成可裁剪的历史项（见 context-window project.ts::projectContext）。
    'turn_id',
    'workspace_root',
    'tier',
    'persona',
    'skills_select',
    // 子代理隔离：父摘要 / 任务提示词 / 父检查点随装配下传，消费方按线程口径取用。
    'parent_summaries',
    'task_prompt',
    'parent_checkpoint',
    // 线程未读收件箱（跨线程投递）：随组装下传给 context-window（所有线程口径均可消费）。
    'inbox_unread',
  ])
  const system = input.model.prompts['system']
  if (isRecord(system) && typeof system['text'] === 'string') out['system_prompt'] = system['text']
  else if (bag['system_prompt'] !== undefined) out['system_prompt'] = bag['system_prompt']
  // item 9 决策：生产默认**不再**往上下文 bag 下传 `extra_messages`——context-window 已改为从会话步日志
  // （`session.turns[].steps`）投影并明确忽略本键（见 context-window candidates.ts）。仅当调用方显式
  // `compat_extra_messages === true`（旧式调用 / 测试兼容）才下传，属惰性兼容键，不影响模型可见性真源。
  // 展示 / 收口路径不读本键（直接读 `rs.extraMessages`，见 commit-parts.ts），故不受影响。
  if (bag['compat_extra_messages'] === true && input.rs.extraMessages.length > 0) out['extra_messages'] = input.rs.extraMessages
  // 阈值单一真源：解析后的扁平 thresholds map（含 `large_artifact_bytes`）随 context bag 下传，
  // 消费方据此覆盖自身 policy 默认，避免两处各定义默认值漂移。
  out['thresholds'] = input.model.thresholds
  // 最近一次完成的模型调用用量随组装下传，供 context-window 校准 token 估算（缺失即不落键）。
  const usage = isRecord(input.rs.shared['last_usage']) ? (input.rs.shared['last_usage'] as Rec) : null
  if (usage !== null) out['usage'] = usage
  return out
}

/**
 * 模型调用的连接实例：把上下文组装算出的 `max_output` 对齐进 `config.params.max_tokens`，
 * 使模型真实输出上限与预算假设一致（否则适配器回落自身默认，预算余量与实际不符）。
 */
function modelConfig(input: NodeDispatchInput): Json {
  const base = input.bag['config']
  if (!isRecord(base)) return base ?? null
  const params = isRecord(input.rs.shared['model_params']) ? (input.rs.shared['model_params'] as Rec) : null
  const maxOutput = params !== null ? params['max_output'] : undefined
  if (typeof maxOutput !== 'number' || !Number.isFinite(maxOutput)) return base
  const configParams = isRecord(base['params']) ? (base['params'] as Rec) : {}
  return { ...base, params: { ...configParams, max_tokens: maxOutput } }
}

/** 模型调用的 bag（agent.step / evolve.propose 共用）。 */
function modelBag(input: NodeDispatchInput): Rec {
  const bag = input.bag
  const messages = input.inputs['messages']
  const out: Rec = {
    config: modelConfig(input),
    messages: Array.isArray(messages) ? messages : input.rs.messages,
  }
  if (Array.isArray(bag['tools'])) out['tools'] = bag['tools']
  if (bag['resilience'] !== undefined) out['resilience'] = bag['resilience']
  if (bag['tool_choice'] !== undefined) out['tool_choice'] = bag['tool_choice']
  // 前缀缓存提示由 context.assemble 产出（厂商中立），原样转发给模型适配器；缺失即不落键。
  const cache = isRecord(input.rs.shared['last_cache']) ? (input.rs.shared['last_cache'] as Rec) : null
  if (cache !== null) out['cache'] = cache
  // 回合身份随模型调用下传：model-protocol 据此把在途 HTTP 请求登记进可中止表。
  if (bag['turn_id'] !== undefined) out['turn_id'] = bag['turn_id']
  return out
}

/** 收件箱消息体 → 文本：字符串原样，其余稳定 JSON 序列化（同输入同文本）。 */
function inboxBodyText(value: Json | undefined): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/**
 * 本线程未读收件箱 → 子代理上下文消息（确定性：按 `bag.inbox_unread` 的声明序，调用方已按 seq 升序）。
 * 渲染与 context-window 同口径：`[收件箱 kind · 来自 from]\nbody`。
 */
function inboxMessages(bag: Rec): Json[] {
  if (!Array.isArray(bag['inbox_unread'])) return []
  const out: Json[] = []
  for (const item of bag['inbox_unread'] as Json[]) {
    if (!isRecord(item)) continue
    const kind = asString(item['kind']) ?? 'instruction'
    const from = asString(item['from']) ?? 'parent'
    out.push({ role: 'user', content: `[收件箱 ${kind} · 来自 ${from}]\n${inboxBodyText(item['body'])}` })
  }
  return out
}

/**
 * 子代理模型调用 bag：上下文 = 任务 + 父检查点 + 本线程未读收件箱，**不含父消息历史**；
 * 返回结构化结果而非子代理全程记录（长任务里最便宜的上下文节省）。
 * 父检查点取自本回合最后一条结构化 `checkpoint` 步记录（同一回合内委派场景）。
 */
function subagentBag(input: NodeDispatchInput): Rec {
  const task = subagentTaskText(input.inputs, input.bag)
  const checkpoint = latestCheckpoint(input.bag, asString(input.bag['turn_id']))
  const messages: Json[] = []
  const system = input.model.prompts['subagent']
  if (isRecord(system) && typeof system['text'] === 'string') messages.push({ role: 'system', content: system['text'] })
  if (task !== null) messages.push({ role: 'user', content: task })
  if (checkpoint !== null && isRecord(checkpoint['summary'])) {
    const text = renderCheckpointText(checkpoint['summary'] as Rec)
    if (text.length > 0) messages.push({ role: 'system', content: `[父检查点]\n${text}` })
  }
  for (const message of inboxMessages(input.bag)) messages.push(message)
  const out: Rec = { config: modelConfig(input), messages, thread_kind: 'subagent' }
  if (checkpoint !== null) out['parent_checkpoint'] = checkpoint
  if (input.bag['turn_id'] !== undefined) out['turn_id'] = input.bag['turn_id']
  return out
}

/** 内建档位 net 映射（sandbox body 缺失时的兜底；与 sandbox tools/default-body.json 同形）。 */
const BUILTIN_TIER_NET: Record<string, string> = {
  auto: 'all',
  severe: 'limited',
  review: 'none',
  deny: 'none',
}

/** 规范化 net 范围：只认 none / limited / all，其余视为 none。 */
export function netScopeOf(value: Json | undefined): string {
  return value === 'limited' || value === 'all' ? value : 'none'
}

/** 某工具声明的 net 需求：从工具目录（bag.tools）按名查 caps.net；查不到按 none。 */
export function declaredNetOf(tool: string, tools: Json[]): string {
  for (const item of tools) {
    if (!isRecord(item) || item['name'] !== tool) continue
    const caps = item['caps']
    return isRecord(caps) ? netScopeOf(caps['net']) : 'none'
  }
  return 'none'
}

/** 当前档位的 net 范围：bag.sandbox_tiers 覆盖 > 内建；未知 / 缺失档位 fail-closed none。 */
export function tierNetOf(tier: Json | undefined, sandboxTiers: Json | undefined): string {
  const tiers = isRecord(sandboxTiers) ? sandboxTiers['tiers'] : undefined
  if (typeof tier === 'string' && isRecord(tiers)) {
    const entry = tiers[tier]
    if (isRecord(entry)) {
      const declared = entry['net']
      if (declared === 'none' || declared === 'limited' || declared === 'all') return declared
    }
  }
  if (typeof tier === 'string' && tier in BUILTIN_TIER_NET) return BUILTIN_TIER_NET[tier]
  return 'none'
}

/** 工具门禁 bag：按 call 逐项判（整批），并带上各 call 声明的 net 与当前档 net 范围供 guard 裁决。 */
function gateBag(input: NodeDispatchInput): Rec {
  const calls = Array.isArray(input.rs.lastCalls) ? input.rs.lastCalls : []
  const tools = Array.isArray(input.bag['tools']) ? (input.bag['tools'] as Json[]) : []
  return {
    calls: calls.map((call) => {
      const tool = typeof call['tool'] === 'string' ? (call['tool'] as string) : ''
      return {
        port: call['port'] ?? '',
        tool: call['tool'] ?? '',
        args: call['args'] ?? {},
        net: declaredNetOf(tool, tools),
      }
    }),
    tier: input.bag['tier'] ?? null,
    tier_net: tierNetOf(input.bag['tier'], input.bag['sandbox_tiers']),
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
    'ignore',
    'question',
    'session',
    'session_id',
    'todo',
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
export function toCalls(value: Json, providerOf: (tool: string) => string): Rec[] {
  const checked = checkToolCalls(isRecord(value) ? value['tool_calls'] : undefined)
  return checked.calls.map((call, index) => {
    const id = typeof call['call_id'] === 'string' ? call['call_id'] : `call-${index}`
    const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
    const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
    return { call_id: id, tool, args, port: providerOf(tool) }
  })
}

/**
 * 工具 → 提供者能力类解析器（供 guard 判据 (port, tool)）。
 * 按当次调用自己的 `bag.tools` 惰性读取，故不持跨调用可变状态：并发 `interpret` 各用各的目录。
 * 缺目录信息回落 `tool`。
 */
export function providerResolver(bag: Rec): (tool: string) => string {
  return (tool: string): string => {
    const tools = bag['tools']
    if (Array.isArray(tools)) {
      for (const item of tools) {
        if (!isRecord(item) || item['name'] !== tool) continue
        return asString(item['provider']) ?? 'tool'
      }
    }
    return 'tool'
  }
}

/**
 * `context.assemble` 前置：调用方未预置工具目录时经 `port.call` #27 `list` 取目录，
 * 写进 `bag.tools`（模型上下文可见）与 `bag.directory`（`tool.dispatch` 复用同一目录，不再现场重建）。
 * 目录已解析（调用方预置 / 本轮已取）即复用；`list` 传输失败按空目录处理，不阻断组装。
 */
async function ensureToolDirectory(input: NodeDispatchInput): Promise<void> {
  const bag = input.bag
  if ((Array.isArray(bag['tools']) && bag['tools'].length > 0) || isRecord(bag['directory'])) {
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

/** 助手展示记录：正文 + 可选用量 + 展示 parts（推理 / 正文 / 工具卡按到达序）。 */
export function assistantRecord(rs: RunState, message: Rec, tools: Json[]): Rec {
  const assistant: Rec = { content: typeof message['content'] === 'string' ? (message['content'] as string) : '' }
  if (isRecord(message['usage'])) assistant['meta'] = { usage: message['usage'] }
  // 纯文本回合不写 parts（content 已覆盖），避免历史无谓膨胀。
  const parts = displayParts(rs.extraMessages, message, tools)
  if (parts.some((part) => isRecord(part) && part['type'] !== 'text')) assistant['parts'] = parts
  return assistant
}

/**
 * 回合收口步：把本轮最终助手消息（含工具卡 / 推理块）作为 step.result 追加进回合日志。
 * 挂起（inputs.pending）与收口共用同一形状：内容都先落盘，结局由 `turn.settle` 另写。
 */
function commitStepRecord(input: NodeDispatchInput): Rec | null {
  const turnId = asString(input.bag['turn_id'])
  if (turnId === null) return null
  const message = isRecord(input.inputs['message']) ? (input.inputs['message'] as Rec) : {}
  const tools = Array.isArray(input.bag['tools']) ? (input.bag['tools'] as Json[]) : []
  const record: Rec = {
    type: 'step.result',
    turn_id: turnId,
    // 单调分配：与 sink 是否最后无关，也不与后写步 / 标记步撞 `(turn_id,type,seq)`。
    seq: nextStepSeq(input.rs),
    assistant: assistantRecord(input.rs, message, tools),
    tool_results: Array.isArray(input.inputs['results']) ? (input.inputs['results'] as Json[]) : [],
  }
  if (isRecord(message['usage'])) record['usage'] = message['usage']
  const reasoning = lastReasoningOf(input.rs)
  // 厂商中立推理块（非展示 parts）：上下文投影按 `step.result.reasoning` 跨段回灌。
  if (reasoning !== undefined) record['reasoning'] = reasoning
  return record
}

/**
 * 本段最近一次模型调用的**厂商中立推理块**（`reasoning_blocks[0]`）或推理文本兜底块；
 * 供 step.result 持久化，使 context-window 投影能按 `step.result.reasoning` 跨段回灌。
 */
export function lastReasoningOf(rs: RunState): Json | undefined {
  return rs.shared['last_reasoning']
}

/** 收口节点：只追加最终内容步记录，不写世界、不定结局（结局由解释器 `turn.settle` 独占）。 */
async function appendCommitStep(input: NodeDispatchInput): Promise<NodeDispatchResult> {
  const record = commitStepRecord(input)
  if (record === null) return { ok: true, value: { appended: false }, outcome: 'ok' }
  const appended = await appendStep(input.port, record)
  if (!appended.ok) {
    return { ok: false, value: { ok: false, error: { code: 'owner_unavailable', message: 'turn step append failed' } }, outcome: 'error', code: 'owner_unavailable' }
  }
  return { ok: true, value: { appended: true }, outcome: 'ok' }
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
    return appendCommitStep(input)
  }
  if (contractIdValue === 'context.assemble') {
    await ensureToolDirectory(input)
    return callPort(input, 'context', 'build', assembleBag(input), false)
  }
  if (contractIdValue === 'recall') {
    // 权威键名取自消费方 memory-retrieval：工作区 `workspace`、预算 `recall_budget`（query 两侧一致）。
    // 源值仍取本插件内部键（`workspace_id` / `budget`），只对齐发出的键名，避免消费方 fail-open 静默回落。
    const out: Rec = {}
    const workspace = input.bag['workspace_id'] ?? input.bag['workspace']
    if (workspace !== undefined && workspace !== null) out['workspace'] = workspace
    const budget = input.bag['recall_budget'] ?? input.bag['budget']
    if (budget !== undefined && budget !== null) out['recall_budget'] = budget
    out['query'] = input.bag['task'] ?? null
    return callPort(input, 'retrieval', 'search', out, false)
  }
  if (contractIdValue === 'subagent') {
    // 子代理隔离：用任务 + 父检查点的专用 bag（不读父消息历史），产出归一为结构化结果。
    const result = await callPort(input, cap, method, subagentBag(input), true)
    if (!result.ok) return result
    return { ...result, value: toSubagentResult(result.value) }
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
  // 已取消的回合不降级重试模型：abort 后的失败不该再起一次调用。
  if (isModel && !isCancelled(asString(input.bag['turn_id']))) {
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
