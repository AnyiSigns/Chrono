// 节点派发的声明式规则：契约经 `bag_pick` / `output_map` / `dispatch` 声明装配与归一，
// 本文件只实现被声明的命名规则（数据表 + 规则函数），不按 contract_id 分支。
// 轻节点按 `bag_pick` + 命名派生字段装配；组装 / 子代理 / 审批 / 校验等重节点用命名 bag 规则。
// `DEFAULT_DISPATCH` 只是未在契约里声明元数据的最小模型（单测直造）的兼容兜底：世界契约数据优先。

import { applyDelta, callTurnHooks } from './hooks.ts'
import { nodeBindings } from './model.ts'
import { asString, isRecord } from './plan.ts'
import { checkToolCalls } from './rules.ts'
import {
  latestCheckpoint,
  renderCheckpointText,
  subagentTaskText,
  toSubagentResult,
} from './subagent.ts'
import type { NodeDispatchInput } from './dispatch.ts'
import type { Json, Rec } from './types.ts'

/** 契约声明的派发元数据：目标、bag 装配、归一。 */
export interface DispatchSpec {
  cap?: string
  method?: string
  /** 从环境 bag 转发的键（缺省不转发）。 */
  bag_pick?: string[]
  /** 节点输入 → bag 字段（值为非 null / 非 undefined 时才落键）。 */
  bind_inputs?: Record<string, string>
  /** 常量注入。 */
  inject?: Rec
  /** 命名派生字段（按声明序求值）。 */
  derive?: string[]
  /** 命名整包装配规则（重节点）。 */
  bag?: string
  /** 调用前命名前置步骤（按声明序执行）。 */
  pre?: string[]
  /** 主调用返回值的命名归一。 */
  output_map?: string
  /** 归一后对节点输出的命名转换。 */
  result_map?: string
  /** 模型调用标记（决定失败是否走降级）。 */
  model?: boolean
  /** 本地纯处理（不发端口）。 */
  local?: string
}

/** 规则间共享的求值上下文（前置步骤写、派生字段读）。 */
export interface DispatchContext {
  collected?: Json[]
}

/** 按环境 bag 键逐项转发（缺省 undefined 不落键）。 */
export function pick(bag: Rec, keys: string[]): Rec {
  const out: Rec = {}
  for (const key of keys) if (bag[key] !== undefined) out[key] = bag[key]
  return out
}

// ── 命名派生字段 ────────────────────────────────────────────────────────────

/** 模型连接实例：把 `max_output` 对齐进 `config.params.max_tokens`。 */
function modelConfig(input: NodeDispatchInput): Json {
  const base = input.bag['config']
  if (!isRecord(base)) return base ?? null
  const params = isRecord(input.rs.shared['model_params']) ? (input.rs.shared['model_params'] as Rec) : null
  const maxOutput = params !== null ? params['max_output'] : undefined
  if (typeof maxOutput !== 'number' || !Number.isFinite(maxOutput)) return base
  const configParams = isRecord(base['params']) ? (base['params'] as Rec) : {}
  return { ...base, params: { ...configParams, max_tokens: maxOutput } }
}

/** 模型调用的可选字段：工具目录 / 韧性 / 选择 / 前缀缓存 / 回合身份（缺失即不落键）。 */
function modelOptional(input: NodeDispatchInput): Rec {
  const out: Rec = {}
  const bag = input.bag
  if (Array.isArray(bag['tools'])) out['tools'] = bag['tools']
  if (bag['resilience'] !== undefined) out['resilience'] = bag['resilience']
  if (bag['tool_choice'] !== undefined) out['tool_choice'] = bag['tool_choice']
  const cache = isRecord(input.rs.shared['last_cache']) ? (input.rs.shared['last_cache'] as Rec) : null
  if (cache !== null) out['cache'] = cache
  if (bag['turn_id'] !== undefined) out['turn_id'] = bag['turn_id']
  return out
}

/** 收件箱消息体 → 文本：字符串原样，其余稳定 JSON 序列化（同输入同文本）。 */
function inboxBodyText(value: Json | undefined): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/** 本线程未读收件箱 → 子代理上下文消息（确定性：按声明序，调用方已按 seq 升序）。 */
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

/** 子代理上下文消息：系统提示词 + 任务 + 父检查点 + 未读收件箱（不含父消息历史）。 */
function subagentMessages(input: NodeDispatchInput): Rec {
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
  return { messages }
}

/** 子代理父检查点：本回合最后一条结构化 `checkpoint` 步记录（无则不落键）。 */
function subagentParentCheckpoint(input: NodeDispatchInput): Rec {
  const checkpoint = latestCheckpoint(input.bag, asString(input.bag['turn_id']))
  return checkpoint !== null ? { parent_checkpoint: checkpoint } : {}
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

/** 工具门禁逐项：每个 call 带上声明的 net，供 guard 判据；整批取最严。 */
function gateCalls(input: NodeDispatchInput): Rec {
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
  }
}

/** 工具派发的调用清单：本段模型产出的 calls（无则空表）。 */
function dispatchCalls(input: NodeDispatchInput): Rec {
  return { calls: Array.isArray(input.rs.lastCalls) ? input.rs.lastCalls : [] }
}

const DERIVES: Record<string, (input: NodeDispatchInput, ctx: DispatchContext) => Rec> = {
  model_config: (input) => ({ config: modelConfig(input) }),
  model_messages: (input) => {
    const messages = input.inputs['messages']
    return { messages: Array.isArray(messages) ? messages : input.rs.messages }
  },
  model_optional: (input) => modelOptional(input),
  prompt_system: (input) => {
    const system = input.model.prompts['system']
    if (isRecord(system) && typeof system['text'] === 'string') return { system_prompt: system['text'] }
    return input.bag['system_prompt'] !== undefined ? { system_prompt: input.bag['system_prompt'] } : {}
  },
  compat_extra_messages: (input) =>
    input.bag['compat_extra_messages'] === true && input.rs.extraMessages.length > 0
      ? { extra_messages: input.rs.extraMessages }
      : {},
  thresholds: (input) => ({ thresholds: input.model.thresholds }),
  loop_nudge: (input) =>
    typeof input.rs.loopNudge === 'string' && input.rs.loopNudge.length > 0 ? { loop_nudge: input.rs.loopNudge } : {},
  last_usage: (input) => {
    const usage = isRecord(input.rs.shared['last_usage']) ? (input.rs.shared['last_usage'] as Rec) : null
    return usage !== null ? { usage } : {}
  },
  context_sources: (_input, ctx) =>
    Array.isArray(ctx.collected) && ctx.collected.length > 0 ? { context_sources: ctx.collected } : {},
  gate_calls: (input) => gateCalls(input),
  tier_net: (input) => ({ tier_net: tierNetOf(input.bag['tier'], input.bag['sandbox_tiers']) }),
  dispatch_calls: (input) => dispatchCalls(input),
  subagent_messages: (input) => subagentMessages(input),
  subagent_parent_checkpoint: (input) => subagentParentCheckpoint(input),
}

// ── 命名整包规则（重节点） ──────────────────────────────────────────────────

/** 模型调用 bag：连接实例 + 消息 + 可选字段（agent.step / evolve.propose / 默认路径共用）。 */
function modelInput(input: NodeDispatchInput): Rec {
  const messages = input.inputs['messages']
  return {
    config: modelConfig(input),
    messages: Array.isArray(messages) ? messages : input.rs.messages,
    ...modelOptional(input),
  }
}

/** 工具门禁 bag：逐项 call 的声明 net + 当前档 net 范围供 guard 裁决。 */
function gateInput(input: NodeDispatchInput): { bag: Rec } {
  return {
    bag: {
      ...gateCalls(input),
      tier: input.bag['tier'] ?? null,
      tier_net: tierNetOf(input.bag['tier'], input.bag['sandbox_tiers']),
      workspace_root: input.bag['workspace_root'] ?? null,
      guard_rules: input.bag['guard_rules'] ?? null,
    },
  }
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

/** verify bag：有命令则装配 shell 校验调用，否则回 `{report:{skipped:true}}`。 */
function verifyInput(input: NodeDispatchInput): { bag: Rec } | { skip: Json } {
  const bindings = nodeBindings(input.instance.node)
  const command = asString(bindings['command']) ?? asString(bindings['verify_command']) ?? asString(bindings['tools'])
  if (command === null) return { skip: { report: { skipped: true } } }
  const out = pick(input.bag, ['workspace_root', 'tier', 'guard_rules', 'tools', 'tools_bindings', 'projection_reads'])
  out['calls'] = [{ call_id: 'verify-0', tool: 'shell', args: { command }, port: 'tool-shell' }]
  return { bag: out }
}

/** 取触发升级的 call（(port, 工具名) 判据来源），读不到回落批内首个 call。 */
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

/** 审批入队 bag：kind 判据归 `approval` 拥有方，随 (port, 工具名) 下传。 */
function approvalInput(input: NodeDispatchInput): { bag: Rec } {
  const bag = input.bag
  const queue = isRecord(bag['approval']) && isRecord((bag['approval'] as Rec)['queue']) ? (bag['approval'] as Rec)['queue'] : bag['queue']
  const refs = isRecord(bag['approval']) && isRecord((bag['approval'] as Rec)['refs']) ? (bag['approval'] as Rec)['refs'] : bag['refs']
  const escalated = escalatedCall(input)
  const port = escalated === null ? 'tool' : escalated.port
  const tool = escalated === null ? '' : escalated.tool
  return {
    bag: {
      port,
      tool,
      queue: queue ?? null,
      refs: refs ?? {},
      cursor: bag['cursor'] ?? null,
      thread: input.env.thread,
      run: input.env.run,
      tier: bag['tier'] ?? null,
      workspace_id: bag['workspace_id'] ?? null,
      args_ref: { summary: tool.length > 0 ? `tool escalation: ${tool}` : 'tool escalation' },
    },
  }
}

const BAGS: Record<string, (input: NodeDispatchInput) => { bag: Rec } | { skip: Json }> = {
  model: (input) => ({ bag: modelInput(input) }),
  gate: (input) => gateInput(input),
  verify: (input) => verifyInput(input),
  approval: (input) => approvalInput(input),
}

// ── 命名前置步骤 ────────────────────────────────────────────────────────────

const PRE_STEPS: Record<string, (input: NodeDispatchInput, ctx: DispatchContext) => Promise<void>> = {
  ensure_tool_directory: async (input) => {
    const bag = input.bag
    if ((Array.isArray(bag['tools']) && bag['tools'].length > 0) || isRecord(bag['directory'])) return
    const listBag = pick(bag, ['tools_bindings', 'mcp_tools'])
    const outcome = await input.port.call('tool-registry', 'list', listBag)
    const value = outcome.ok ? outcome.value : null
    const tools = isRecord(value) && Array.isArray(value['tools']) ? (value['tools'] as Json[]) : []
    const rejected = isRecord(value) && Array.isArray(value['rejected']) ? (value['rejected'] as Json[]) : []
    bag['tools'] = tools
    bag['directory'] = { tools, rejected }
    input.trace.recordEff(input.iter, 'tool-registry', 'list', listBag, value, outcome.ok ? 'ok' : 'transport_failed')
  },
  collect_context_sources: async (input, ctx) => {
    const records: Json[] = []
    for (const provider of input.contextSources ?? []) {
      const outcome = await input.port.call('context-source', 'collect', input.bag, { provider })
      if (!outcome.ok) {
        input.trace.recordEff(
          input.iter,
          'context-source',
          'collect',
          { provider },
          { code: outcome.code },
          'transport_failed',
        )
        continue
      }
      const list =
        isRecord(outcome.value) && Array.isArray(outcome.value['records'])
          ? (outcome.value['records'] as Json[])
          : []
      for (const item of list) records.push(item)
      input.trace.recordEff(input.iter, 'context-source', 'collect', { provider }, outcome.value, 'ok')
    }
    ctx.collected = records
  },
  before_assemble_hook: async (input) => {
    const delta = await callTurnHooks(input.port, input.turnHooks ?? [], 'before-assemble', {
      node_index: input.nodeIndex,
      iter: input.iter,
    })
    applyDelta(input.rs, delta)
  },
}

// ── 命名归一 ────────────────────────────────────────────────────────────────

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
  if (typeof raw['reasoning'] === 'string' && (raw['reasoning'] as string).length > 0) {
    message['reasoning'] = raw['reasoning']
  }
  if (isRecord(raw['usage'])) message['usage'] = raw['usage']
  if (checked.calls.length > 0) {
    message['tool_calls'] = checked.calls.map((call) => ({
      id: call['call_id'],
      name: call['tool'],
      arguments: call['args'] ?? {},
    }))
  }
  return { ...raw, message, tool_calls: checked.calls }
}

const OUTPUT_MAPS: Record<string, (value: Json) => Json> = {
  identity: (value) => value,
  step_output: (value) => stepOutput(value),
  gate_verdict: (value) =>
    isRecord(value)
      ? { ...value, verdict: strictest(value) }
      : { decisions: [], summary: { allow: 0, escalate: 0, deny: 0 }, verdict: 'allow' },
  approval_pending: (value) => (isRecord(value) ? { ...value, decision: 'pending' } : value),
}

/** 按调用目标归一（未声明 output_map 时的按 (cap, method) 口径）。 */
export function normalizeFor(cap: string, method: string, value: Json): Json {
  if (cap === 'model' && method === 'chat') return OUTPUT_MAPS['step_output'](value)
  if (cap === 'guard' && method === 'judge') return OUTPUT_MAPS['gate_verdict'](value)
  if (cap === 'approval' && method === 'enqueue') return OUTPUT_MAPS['approval_pending'](value)
  return value
}

const RESULT_MAPS: Record<string, (value: Json) => Json> = {
  verify_report: (value) => ({ report: verifyOutput(value) }),
  subagent_result: (value) => toSubagentResult(value),
}

// ── 契约元数据读取 ──────────────────────────────────────────────────────────

function contractIdOf(contract: Rec): string | null {
  return typeof contract['contract_id'] === 'string' ? contract['contract_id'] : null
}

function readSpecField<T>(source: Rec, key: string, check: (value: Json) => value is T): T | null {
  const value = source[key]
  return check(value) ? value : null
}

function isStringArray(value: Json): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 从契约条目读取显式派发元数据（无意声明时返回 null）。 */
function declaredSpec(contract: Rec): DispatchSpec | null {
  const dispatch = isRecord(contract['dispatch']) ? (contract['dispatch'] as Rec) : null
  const bagPick = readSpecField(contract, 'bag_pick', isStringArray)
  const outputMap = readSpecField(contract, 'output_map', (value): value is string => typeof value === 'string')
  const resultMap = readSpecField(contract, 'result_map', (value): value is string => typeof value === 'string')
  if (dispatch === null && bagPick === null && outputMap === null && resultMap === null) return null
  const spec: DispatchSpec = {}
  if (dispatch !== null) {
    const cap = readSpecField(dispatch, 'cap', (value): value is string => typeof value === 'string')
    const method = readSpecField(dispatch, 'method', (value): value is string => typeof value === 'string')
    const bag = readSpecField(dispatch, 'bag', (value): value is string => typeof value === 'string')
    const local = readSpecField(dispatch, 'local', (value): value is string => typeof value === 'string')
    const derive = readSpecField(dispatch, 'derive', isStringArray)
    const pre = readSpecField(dispatch, 'pre', isStringArray)
    if (cap !== null) spec.cap = cap
    if (method !== null) spec.method = method
    if (bag !== null) spec.bag = bag
    if (local !== null) spec.local = local
    if (derive !== null) spec.derive = derive
    if (pre !== null) spec.pre = pre
    if (dispatch['model'] === true) spec.model = true
    if (isRecord(dispatch['inject'])) spec.inject = dispatch['inject'] as Rec
    if (isRecord(dispatch['bind_inputs'])) {
      const bind: Record<string, string> = {}
      for (const [key, value] of Object.entries(dispatch['bind_inputs'] as Rec)) {
        if (typeof value === 'string') bind[key] = value
      }
      spec.bind_inputs = bind
    }
  }
  if (bagPick !== null) spec.bag_pick = bagPick
  if (outputMap !== null) spec.output_map = outputMap
  if (resultMap !== null) spec.result_map = resultMap
  return spec
}

/** 未声明元数据时的内建兜底（仅覆盖种子词汇；世界契约数据优先）。 */
export const DEFAULT_DISPATCH: Record<string, DispatchSpec> = {
  'context.assemble': {
    bag_pick: [
      'config',
      'input',
      'session',
      'style',
      'skills',
      'tools',
      'thread_kind',
      'thread',
      'turn_id',
      'workspace_root',
      'tier',
      'persona',
      'skills_select',
      'parent_summaries',
      'task_prompt',
      'parent_checkpoint',
      'inbox_unread',
    ],
    derive: ['prompt_system', 'compat_extra_messages', 'thresholds', 'loop_nudge', 'last_usage', 'context_sources'],
    pre: ['ensure_tool_directory', 'collect_context_sources', 'before_assemble_hook'],
  },
  'agent.step': { derive: ['model_config', 'model_messages', 'model_optional'], output_map: 'step_output', model: true },
  'evolve.propose': { derive: ['model_config', 'model_messages', 'model_optional'], output_map: 'step_output', model: true },
  'tool.gate': {
    bag_pick: ['tier', 'workspace_root', 'guard_rules'],
    derive: ['gate_calls', 'tier_net'],
    output_map: 'gate_verdict',
  },
  'approval.wait': { bag: 'approval', output_map: 'approval_pending' },
  'tool.dispatch': {
    bag_pick: [
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
      'cursor',
    ],
    derive: ['dispatch_calls'],
    bind_inputs: { verdicts: 'verdict' },
  },
  verify: { bag: 'verify', result_map: 'verify_report' },
  join: { local: 'join' },
  subagent: {
    bag_pick: ['turn_id'],
    inject: { thread_kind: 'subagent' },
    derive: ['model_config', 'subagent_messages', 'subagent_parent_checkpoint'],
    output_map: 'step_output',
    result_map: 'subagent_result',
    model: true,
  },
  'turn.commit': { local: 'commit_step' },
}

/** 解析契约的派发元数据：显式声明优先，否则按内建兜底；都没有返回 null。 */
export function dispatchSpecOf(contract: Rec): DispatchSpec | null {
  const declared = declaredSpec(contract)
  if (declared !== null) return declared
  const id = contractIdOf(contract)
  return id !== null ? DEFAULT_DISPATCH[id] ?? null : null
}

/** 组装调用 bag：`bag_pick` → `inject` → 输入绑定 → 命名派生字段。 */
export async function buildBag(
  input: NodeDispatchInput,
  spec: DispatchSpec,
  ctx: DispatchContext,
): Promise<Rec> {
  const bag = pick(input.bag, spec.bag_pick ?? [])
  if (spec.inject !== undefined) {
    for (const [key, value] of Object.entries(spec.inject)) bag[key] = value
  }
  if (spec.bind_inputs !== undefined) {
    for (const [target, name] of Object.entries(spec.bind_inputs)) {
      const value = input.inputs[name]
      if (value !== undefined && value !== null) bag[target] = value
    }
  }
  for (const rule of spec.derive ?? []) Object.assign(bag, DERIVES[rule](input, ctx))
  return bag
}

export function buildNamedBag(input: NodeDispatchInput, name: string): { bag: Rec } | { skip: Json } {
  const rule = BAGS[name]
  return rule === undefined ? { bag: {} } : rule(input)
}

export async function runPreStep(input: NodeDispatchInput, name: string, ctx: DispatchContext): Promise<void> {
  const step = PRE_STEPS[name]
  if (step !== undefined) await step(input, ctx)
}

export function applyOutputMap(name: string, value: Json): Json {
  const map = OUTPUT_MAPS[name]
  return map === undefined ? value : map(value)
}

export function applyResultMap(name: string, value: Json): Json {
  const map = RESULT_MAPS[name]
  return map === undefined ? value : map(value)
}

/** 默认模型 bag（未声明契约的兼容路径按此装配）。 */
export function defaultModelBag(input: NodeDispatchInput): Rec {
  return modelInput(input)
}
