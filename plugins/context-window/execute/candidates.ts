// 流水线第 0 / 1 步：候选汇集、结构化 → 规范消息（RawMessage）。
// 一切输入随 bag 由调用方入口 term 装配传入（服务不读投影）；本轮用户消息 / 系统提示 / 工具 schema /
// 收件箱 / 技能 / 历史 / 风格；线程口径按 bag.thread_kind 调输入。
//
// 装配器化：候选来源是**一组 contributor**——内建 7 类默认来源各是一个 `Contributor` 函数，
// 与外部 `context-source` 记录同形。每个 contributor 只产出中性 `ContextRecord`
// （自报 source / role / parts / priority / stability），装配器按序机械转候选；装配器不枚举来源身份。
//
// 历史与同回合记录同源于会话回合日志（`session.turns[].steps`），经 `project.ts` 投影成中性模型记录，
// 不再解析展示 parts / 工具卡 / `refs`。`bag.extra_messages` 不再消费（同回合进度改由步日志派生）。

import { recordToRaw } from './contributions.ts'
import { messageParts } from './history.ts'
import { projectContext } from './project.ts'
import { computeTokenKey, isRecord, parseAt, stableStringify } from './text.ts'
import { turnMetadata, type TurnMetadata } from './views.ts'
import type { CanonicalPart, ContextRecord, Json, MessagePolicy, NeutralReasoning, Policy, RawMessage, Stability } from './types.ts'

/** 优先级常量：数值越小越优先、越不可裁。内建来源自报，保留阶梯按它分区。 */
export const PRIORITY = {
  prompt: 0,
  tools: 0,
  input: 0,
  skill: 2,
  history: 4,
  style: 5,
} as const

/** contributor 运行上下文：装配器一次装配内的只读切片。 */
export interface GatherContext {
  bag: Record<string, unknown>
  policy: Policy
  session: Record<string, unknown>
  turns: TurnMetadata
  threadKind: string
  model: string
}

/** 候选来源：只声明事实，返回中性记录（可为空）。内建默认来源与外部扩展点同形。 */
export type Contributor = (ctx: GatherContext) => ContextRecord[]

export interface Gathered {
  raws: RawMessage[]
  flags: string[]
  /** 回合日志元数据（距离 / 步号）：供分层保留使用。 */
  turns: TurnMetadata
}

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 内建来源的稳定性自报：与 policy 前缀边界一致（prompt / tools 稳定，其余动态）。 */
function stabilityOf(source: string, policy: Policy): Stability {
  return policy.prefix.stable.includes(source) ? 'stable' : 'dynamic'
}

/**
 * 模型可见的工具参数 schema：优先 `schema`，其次中性声明的 `argsSchema`，缺省空对象。
 * 只把 name / description / 参数 schema 给模型；声明里的内部字段（provider / kind / caps / render 等）不外泄。
 */
function modelToolSchema(tool: Record<string, unknown>): Json {
  const raw = tool['schema'] !== undefined ? tool['schema'] : tool['argsSchema']
  return isRecord(raw) ? (raw as Json) : { type: 'object' }
}

/** 父会话摘要消息体 → 文本：字符串原样，其余稳定 JSON 序列化（同输入同文本）。 */
function parentSummaryText(entry: unknown): string {
  if (typeof entry === 'string') return entry
  const summary = isRecord(entry) && entry['summary'] !== undefined ? entry['summary'] : entry
  if (typeof summary === 'string') return summary
  if (summary === null || summary === undefined) return ''
  return stableStringify(summary as Json)
}

/** 收件箱消息体 → 文本：字符串原样，其余稳定 JSON 序列化（同输入同文本）。 */
function inboxBodyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return stableStringify(value as Json)
}

/**
 * 归一推理块为厂商中立形态：对象形态原样保留 payload / signature / encrypted（不重排 / 不截断），
 * 仅补缺失的固定字段；字符串形态（旧模型层）编成文本块。payload 非字符串即视为非法块，返回 null。
 */
function neutralReasoning(value: unknown, model: string): NeutralReasoning | null {
  if (isRecord(value)) {
    if (typeof value['payload'] !== 'string') return null
    return {
      provider: typeof value['provider'] === 'string' ? (value['provider'] as string) : '',
      model: typeof value['model'] === 'string' ? (value['model'] as string) : '',
      form: value['form'] === 'blocks' ? 'blocks' : 'text',
      payload: value['payload'] as string,
      signature: typeof value['signature'] === 'string' ? (value['signature'] as string) : '',
      encrypted: typeof value['encrypted'] === 'string' ? (value['encrypted'] as string) : '',
      tokens: typeof value['tokens'] === 'number' && Number.isFinite(value['tokens']) ? (value['tokens'] as number) : 0,
    }
  }
  if (typeof value === 'string' && value.length > 0) {
    return { provider: '', model, form: 'text', payload: value, signature: '', encrypted: '', tokens: 0 }
  }
  return null
}

/** 平台展示名（`process.platform` 是确定性运行态事实，不涉时间 / 随机）。 */
const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

/**
 * 稳定「环境」节：把工作目录与平台告诉模型（此前二者从未进模型上下文，模型只能猜路径）。
 * 只有 bag 给出非空 `workspace_root` 时才注入——无工作目录时不虚报一个根。
 * 文本不含内部标识符，避免污染模型推理。
 */
function environmentText(policy: MessagePolicy, bag: Record<string, unknown>): string | null {
  const root = asString(bag['workspace_root'])
  if (root === null) return null
  const platform = PLATFORM_LABELS[process.platform] ?? process.platform
  const values: Record<string, string> = { workspace_root: root, platform }
  const text = policy.environment.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
  return text.trim().length > 0 ? text : null
}

/** 工具列表按名排序（同名单调稳定），保证前缀不随 pins / 绑定 / MCP 到达顺序漂移。 */
function sortTools(tools: Json[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const tool of tools) if (isRecord(tool)) records.push(tool)
  records.sort((left, right) => {
    const a = typeof left['name'] === 'string' ? (left['name'] as string) : ''
    const b = typeof right['name'] === 'string' ? (right['name'] as string) : ''
    return a < b ? -1 : a > b ? 1 : 0
  })
  return records
}

/** 内建系统类来源记录（prompt / skill / style 共用；source / priority 由来源自报）。 */
function systemRecord(
  source: string,
  text: string,
  priority: number,
  stability: Stability,
): ContextRecord {
  return { source, role: 'system', parts: [textPart(text)], priority, stability, at: 0 }
}

/** 内建用户类来源记录（input / 收件箱 / 任务提示 / 议题共用）。 */
function userRecord(
  parts: CanonicalPart[],
  priority: number,
  stability: Stability,
  at: number,
  from: string | null = null,
): ContextRecord {
  return { source: 'input', role: 'user', parts, priority, stability, at, from }
}

/** 本轮用户消息。 */
function contributeInput(ctx: GatherContext): ContextRecord[] {
  const input = ctx.bag['input']
  const stability = stabilityOf('input', ctx.policy)
  if (typeof input === 'string') return [userRecord([textPart(input)], PRIORITY.input, stability, 0)]
  if (isRecord(input)) {
    const parsed = messageParts(input)
    if (parsed.parts.length > 0) return [userRecord(parsed.parts, PRIORITY.input, stability, parseAt(input['at']))]
  }
  return []
}

/** 系统提示（稳定前缀）。 */
function contributeSystemPrompt(ctx: GatherContext): ContextRecord[] {
  const systemPrompt = asString(ctx.bag['system_prompt'])
  if (systemPrompt === null) return []
  return [systemRecord('prompt', systemPrompt, PRIORITY.prompt, stabilityOf('prompt', ctx.policy))]
}

/** 稳定「环境」节（工作目录 / 平台 / 命令解释器）：紧跟系统提示，同属稳定前缀（source='prompt'）。 */
function contributeEnvironment(ctx: GatherContext): ContextRecord[] {
  const environment = environmentText(ctx.policy.messages, ctx.bag)
  if (environment === null) return []
  return [systemRecord('prompt', environment, PRIORITY.prompt, stabilityOf('prompt', ctx.policy))]
}

/**
 * 空转 nudge（graph-run 空转检测升级阶梯的第一步）：**前导**系统消息，明确标为系统引导，
 * 不放在消息列尾部（尾插的 system 会被当成用户最新指令）。仅命中空转的那一段出现，随后清除。
 */
function contributeLoopNudge(ctx: GatherContext): ContextRecord[] {
  const loopNudge = asString(ctx.bag['loop_nudge'])
  if (loopNudge === null) return []
  return [
    systemRecord(
      'prompt',
      `[系统引导 · 空转提示]\n${loopNudge}`,
      PRIORITY.prompt,
      stabilityOf('prompt', ctx.policy),
    ),
  ]
}

/** 工具 schema（按名排序 + 稳定 JSON 键序 = 稳定前缀，每工具一条）。 */
function contributeTools(ctx: GatherContext): ContextRecord[] {
  if (!Array.isArray(ctx.bag['tools'])) return []
  const stability = stabilityOf('tools', ctx.policy)
  const records: ContextRecord[] = []
  for (const tool of sortTools(ctx.bag['tools'] as Json[])) {
    const name = asString(tool['name']) ?? ''
    const description = asString(tool['description'])
    const body: Record<string, Json> = { name }
    if (description !== null) body['description'] = description
    body['schema'] = modelToolSchema(tool)
    records.push(systemRecord('tools', stableStringify(body as unknown as Json), PRIORITY.tools, stability))
  }
  return records
}

/**
 * 本线程未读收件箱（**所有线程口径**）：跨线程投递的未读消息按 seq 序注入。
 * source=input、优先级同技能；渲染与 loop-policy 子代理调用同口径。
 */
function contributeInbox(ctx: GatherContext): ContextRecord[] {
  if (!Array.isArray(ctx.bag['inbox_unread'])) return []
  const stability = stabilityOf('input', ctx.policy)
  const records: ContextRecord[] = []
  for (const item of ctx.bag['inbox_unread'] as Json[]) {
    if (!isRecord(item)) continue
    const kind = asString(item['kind']) ?? 'instruction'
    const from = asString(item['from']) ?? 'parent'
    records.push(
      userRecord(
        [textPart(`[收件箱 ${kind} · 来自 ${from}]\n${inboxBodyText(item['body'])}`)],
        PRIORITY.skill,
        stability,
        parseAt(item['at']),
        from,
      ),
    )
  }
  return records
}

/**
 * 子代理线程：父摘要 / 任务提示词。
 * 子代理隔离：上下文 = 任务 + 父摘要，不继承父消息历史（历史块按线程口径跳过）。
 */
function contributeSubagent(ctx: GatherContext): ContextRecord[] {
  if (ctx.threadKind !== 'subagent') return []
  const records: ContextRecord[] = []
  if (Array.isArray(ctx.bag['parent_summaries'])) {
    for (const entry of ctx.bag['parent_summaries'] as Json[]) {
      const text = parentSummaryText(entry)
      if (text.length === 0) continue
      records.push(systemRecord('prompt', `[父会话摘要]\n${text}`, PRIORITY.prompt, stabilityOf('prompt', ctx.policy)))
    }
  }
  const taskPrompt = asString(ctx.bag['task_prompt'])
  if (taskPrompt !== null) {
    records.push(userRecord([textPart(taskPrompt)], PRIORITY.input, stabilityOf('input', ctx.policy), 0))
  }
  return records
}

/** group 线程：本轮发言者人格 + 圆桌议题。 */
function contributeGroup(ctx: GatherContext): ContextRecord[] {
  if (ctx.threadKind !== 'group') return []
  const records: ContextRecord[] = []
  const persona = asString(ctx.bag['persona'])
  if (persona !== null) {
    records.push(systemRecord('prompt', `[本轮发言者人格]\n${persona}`, PRIORITY.prompt, stabilityOf('prompt', ctx.policy)))
  }
  const topic = asString(ctx.bag['topic'])
  if (topic !== null) {
    records.push(userRecord([textPart(`[圆桌议题]\n${topic}`)], PRIORITY.input, stabilityOf('input', ctx.policy), 0))
  }
  return records
}

/** 技能片段。 */
function contributeSkills(ctx: GatherContext): ContextRecord[] {
  if (!Array.isArray(ctx.bag['skills'])) return []
  const stability = stabilityOf('skill', ctx.policy)
  const records: ContextRecord[] = []
  for (const skill of ctx.bag['skills'] as Json[]) {
    if (!isRecord(skill)) continue
    const name = asString(skill['name']) ?? asString(skill['id']) ?? ''
    const content = asString(skill['content']) ?? asString(skill['text']) ?? ''
    const title = name.length > 0 ? `技能 ${name}` : '技能'
    records.push(systemRecord('skill', `[${title}]\n${content}`, PRIORITY.skill, stability))
  }
  return records
}

/**
 * 历史与同回合记录同源：会话回合日志经 `project.ts` 投影成中性模型记录（模型形状，不读展示 parts）。
 * workflow 不组装消息历史；group 给正文加发言者前缀；subagent 只取任务与父摘要，不继承父历史。
 * `bag.turn_id` = 本轮回合身份：投影据此跳过本轮用户消息（`input` 权威）、把本轮其余记录标本轮口径。
 */
function contributeHistory(ctx: GatherContext): ContextRecord[] {
  if (ctx.threadKind === 'workflow' || ctx.threadKind === 'subagent') return []
  const currentTurnId = asString(ctx.bag['turn_id'])
  const projected = projectContext(ctx.session, ctx.turns, currentTurnId)
  const records: ContextRecord[] = []
  for (const record of projected.records) {
    let parts = record.parts
    let tokenKey: string | null = null
    if (ctx.threadKind === 'group' && record.from !== null && parts.length > 0 && parts[0]?.type === 'text') {
      parts = [{ type: 'text', text: `${record.from}: ${(parts[0] as { text: string }).text}` }, ...parts.slice(1)]
      tokenKey = computeTokenKey(parts)
    }
    const reasoning = record.reasoning !== null ? neutralReasoning(record.reasoning, ctx.model) : null
    records.push({
      source: record.source,
      role: record.role,
      parts,
      priority: record.priority,
      stability: stabilityOf(record.source, ctx.policy),
      atomic: record.group !== null,
      atomicGroup: record.group,
      toolCallId: record.toolCallId,
      from: record.from,
      turnId: record.turnId,
      step: record.step,
      toolCalls: record.toolCalls,
      reasoning,
      toolResult: record.toolResult,
      error: record.error,
      tokenKey,
    })
  }
  return records
}

/** 风格片段。 */
function contributeStyle(ctx: GatherContext): ContextRecord[] {
  const style = ctx.bag['style']
  const styleText =
    typeof style === 'string'
      ? style
      : isRecord(style)
        ? asString(style['text']) ?? asString(style['content'])
        : null
  if (styleText === null || styleText.length === 0) return []
  return [systemRecord('style', styleText, PRIORITY.style, stabilityOf('style', ctx.policy))]
}

/**
 * 内置默认 contributor 列表（顺序即产出顺序；与外部 `context-source` 记录同形）。
 * 迁移手法：现 7 类来源原样住此列表，外部 provider 经 `bag.context_sources` 汇入，按需再外迁。
 */
export const BUILTIN_CONTRIBUTORS: readonly Contributor[] = [
  contributeInput,
  contributeSystemPrompt,
  contributeEnvironment,
  contributeLoopNudge,
  contributeTools,
  contributeInbox,
  contributeSubagent,
  contributeGroup,
  contributeSkills,
  contributeHistory,
  contributeStyle,
]

/**
 * 汇集候选并结构化（第 0 / 0b / 1 步）。
 * `external` 为调用方（graph-run `context.assemble` 前置）经 `context-source` 成员汇集的中性记录，
 * 在内建 contributor 之后机械追加；内建来源的产出与顺序不因外部成员而变。
 */
export function gatherCandidates(
  bag: Record<string, unknown>,
  policy: Policy,
  external: ContextRecord[] = [],
): Gathered {
  const config = isRecord(bag['config']) ? bag['config'] : {}
  const session = isRecord(bag['session']) ? bag['session'] : {}
  const ctx: GatherContext = {
    bag,
    policy,
    session,
    turns: turnMetadata(session),
    threadKind: asString(bag['thread_kind']) ?? 'main',
    model: asString(config['model']) ?? 'unknown',
  }
  const raws: RawMessage[] = []
  let order = 0
  const next = (): number => {
    order += 1
    return order
  }
  for (const contribute of BUILTIN_CONTRIBUTORS) {
    for (const record of contribute(ctx)) raws.push(recordToRaw(record, next()))
  }
  // 同回合 iter 间产物不再经 `bag.extra_messages` 回灌：改由会话步日志投影（History contributor）派生。
  // `bag.extra_messages` 仍被接受但忽略（生产者可由 W1 下线）。

  // 外部 `context-source` 贡献（调用方按成员表码元序汇集）：机械转候选并续排 orderHint；
  // 是否保留 / 排序由记录的 priority / stability 决定，装配器不枚举来源。
  for (const record of external) raws.push(recordToRaw(record, next()))

  return { raws, flags: [], turns: ctx.turns }
}
