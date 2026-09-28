// 流水线第 0 / 0b / 1 步：候选汇集、L1 TTL 过滤、结构化 → 规范消息（RawMessage）。
// 一切输入随 bag 由调用方入口 term 装配传入（服务不读投影）；本轮用户消息 / 系统提示 / 工具 schema /
// L2 / 上一会话 L1 / 本会话 L1 / 技能 / L3 召回 / 历史 / 风格；线程口径按 bag.thread_kind 调输入。
//
// 跨回合作业：历史里的展示工具卡（`type:'tool'`）提升为可回灌的 assistant(tool_calls) + tool(结果摘要)，
// 结果按机械规则老化并带句柄；同回合 `extra_messages` 的推理块按厂商中立形态回灌。

import { ageResultText, interruptedResult } from './aging.ts'
import { atomicGroups, messageParts, normalizeRole, planHistory } from './history.ts'
import { computeTokenKey, isRecord, parseAt, parseExpiresAt, renderMemory, stableStringify } from './text.ts'
import { messageTurnId, renderCheckpoint, turnMetadata, isStructuredCheckpoint, type TurnMetadata } from './views.ts'
import type { CallEnv, CanonicalPart, Json, MessagePolicy, NeutralReasoning, Policy, RawMessage } from './types.ts'

/** 优先级常量：数值越小越优先、越不可裁。 */
export const PRIORITY = {
  prompt: 0,
  tools: 0,
  input: 0,
  memory: 1,
  skill: 2,
  recall: 3,
  history: 4,
  style: 5,
} as const

export interface Gathered {
  raws: RawMessage[]
  flags: string[]
  recallEntries: { entry: string; score: number }[]
  coveredUpto: string | null
  l1Valid: boolean
  /** 回合日志元数据（距离 / 步号 / 检查点覆盖）：供分层保留使用。 */
  turns: TurnMetadata
  /** 最新结构化检查点注入的消息（无检查点为 null）。 */
  checkpoint: RawMessage | null
}

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 消息 `meta.error`（session 的 commitError 落盘形态）：非空字符串才认。 */
function metaError(body: Record<string, unknown>): string | null {
  const meta = isRecord(body['meta']) ? body['meta'] : null
  const error = meta === null ? undefined : meta['error']
  return typeof error === 'string' && error.length > 0 ? error : null
}

/**
 * 模型可见的工具参数 schema：优先 `schema`，其次中性声明的 `argsSchema`，缺省空对象。
 * 只把 name / description / 参数 schema 给模型；声明里的内部字段（provider / kind / caps / render 等）不外泄。
 */
function modelToolSchema(tool: Record<string, unknown>): Json {
  const raw = tool['schema'] !== undefined ? tool['schema'] : tool['argsSchema']
  return isRecord(raw) ? (raw as Json) : { type: 'object' }
}

function memoryText(title: string, entry: Record<string, unknown>): string {
  return renderMemory(title, entry['summary'])
}

/** 记忆条目是否已过期（`expires_at <= env.now`）。 */
function isExpired(entry: Record<string, unknown>, env: CallEnv): boolean {
  const expiresAt = parseExpiresAt(entry['expires_at'])
  return expiresAt !== null && expiresAt <= env.now
}

function memoryRaw(
  title: string,
  entry: Record<string, unknown>,
  source: RawMessage['source'],
  orderHint: number,
): RawMessage {
  return {
    role: 'system',
    parts: [textPart(memoryText(title, entry))],
    source,
    priority: PRIORITY.memory,
    at: parseAt(entry['at']),
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint,
  }
}

/**
 * 子代理的父检查点消息：接受 `checkpoint` 步记录（`{summary,…}`）或裸 summary，
 * 仅结构化检查点可注入（段标记 / verify 报告等内部标记不算）；无结构化字段返回 null。
 */
function parentCheckpointRaw(value: unknown, orderHint: number): RawMessage | null {
  if (!isRecord(value)) return null
  const summary = isRecord(value['summary']) ? value['summary'] : value
  if (!isStructuredCheckpoint(summary)) return null
  const text = renderCheckpoint(summary)
  if (text.trim().length === 0) return null
  return {
    role: 'system',
    parts: [textPart(`[父检查点]\n${text}`)],
    source: 'l1',
    priority: PRIORITY.memory,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint,
  }
}

function inputRaw(parts: CanonicalPart[], priority: number, at: number, orderHint: number, from: string | null = null): RawMessage {
  return {
    role: 'user',
    parts,
    source: 'input',
    priority,
    at,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from,
    orderHint,
  }
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

/** 汇集候选并结构化（第 0 / 0b / 1 步）。 */
export function gatherCandidates(bag: Record<string, unknown>, env: CallEnv, policy: Policy): Gathered {
  const raws: RawMessage[] = []
  const flags: string[] = []
  const history = planHistory(bag)
  if (!history.l1Valid) flags.push('l1_invalid')
  const session = isRecord(bag['session']) ? bag['session'] : {}
  const turns = turnMetadata(session)
  let checkpoint: RawMessage | null = null

  const memories = isRecord(bag['memories']) ? bag['memories'] : {}
  const threadKind = asString(bag['thread_kind']) ?? 'main'
  const config = isRecord(bag['config']) ? bag['config'] : {}
  const model = asString(config['model']) ?? 'unknown'
  let order = 0
  const next = (): number => {
    order += 1
    return order
  }

  // 本轮用户消息
  const input = bag['input']
  if (typeof input === 'string') {
    raws.push(inputRaw([textPart(input)], PRIORITY.input, 0, next()))
  } else if (isRecord(input)) {
    const parsed = messageParts(input)
    if (parsed.parts.length > 0) {
      raws.push(inputRaw(parsed.parts, PRIORITY.input, parseAt(input['at']), next()))
    }
  }

  // 系统提示
  const systemPrompt = asString(bag['system_prompt'])
  if (systemPrompt !== null) {
    raws.push({
      role: 'system',
      parts: [textPart(systemPrompt)],
      source: 'prompt',
      priority: PRIORITY.prompt,
      at: 0,
      atomic: false,
      atomicGroup: null,
      toolCallId: null,
      from: null,
      orderHint: next(),
    })
  }

  // 稳定「环境」节（工作目录 / 平台 / 命令解释器）：紧跟系统提示，同属稳定前缀（source='prompt'）。
  const environment = environmentText(policy.messages, bag)
  if (environment !== null) {
    raws.push({
      role: 'system',
      parts: [textPart(environment)],
      source: 'prompt',
      priority: PRIORITY.prompt,
      at: 0,
      atomic: false,
      atomicGroup: null,
      toolCallId: null,
      from: null,
      orderHint: next(),
    })
  }

  // 工具 schema（按名排序 + 稳定 JSON 键序 = 稳定前缀）
  if (Array.isArray(bag['tools'])) {
    for (const tool of sortTools(bag['tools'] as Json[])) {
      const name = asString(tool['name']) ?? ''
      const description = asString(tool['description'])
      const body: Record<string, Json> = { name }
      if (description !== null) body['description'] = description
      body['schema'] = modelToolSchema(tool)
      raws.push({
        role: 'system',
        parts: [textPart(stableStringify(body as unknown as Json))],
        source: 'tools',
        priority: PRIORITY.tools,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        orderHint: next(),
      })
    }
  }

  // L2 工作区记忆（过期按来源记 l2_expired，不复用 L1 的 flag）
  const l2 = isRecord(memories['l2']) ? memories['l2'] : null
  if (l2 !== null) {
    if (isExpired(l2, env)) flags.push('l2_expired')
    else raws.push(memoryRaw('工作区记忆', l2, 'l2', next()))
  }

  // 上一会话 L1（subagent 去掉）
  const prevL1 = isRecord(memories['prev_l1']) ? memories['prev_l1'] : null
  if (prevL1 !== null && threadKind !== 'subagent') {
    if (isExpired(prevL1, env)) flags.push('l1_expired')
    else raws.push(memoryRaw('上一会话摘要', prevL1, 'l1', next()))
  }

  // 本会话 L1（covered_upto 失效 ⇒ 丢弃该 L1，交给下次压缩重建）
  const l1 = isRecord(memories['l1']) ? memories['l1'] : null
  if (l1 !== null && history.l1Valid) {
    if (isExpired(l1, env)) flags.push('l1_expired')
    else raws.push(memoryRaw('本会话摘要', l1, 'l1', next()))
  }

  // 结构化检查点：作为历史头部注入。它覆盖的旧回合不再逐条回灌，由本检查点替代；
  // 记录本身仍留 `view.display` 与 `context.expand`。
  if (turns.checkpoint !== null) {
    const text = renderCheckpoint(turns.checkpoint.summary)
    if (text.trim().length > 0) {
      checkpoint = {
        role: 'system',
        parts: [textPart(`[检查点]\n${text}`)],
        source: 'l1',
        priority: PRIORITY.memory,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        orderHint: next(),
        checkpoint: true,
      }
      raws.push(checkpoint)
    }
  }

  // 线程：subagent 的父检查点 / 任务提示词 / 未读收件箱。
  // 子代理隔离：上下文 = 任务 + 父检查点，不继承父消息历史（历史块按线程口径跳过）。
  if (threadKind === 'subagent') {
    const parentCheckpoint = parentCheckpointRaw(bag['parent_checkpoint'], next())
    if (parentCheckpoint !== null) {
      raws.push(parentCheckpoint)
    } else if (Array.isArray(bag['parent_summaries'])) {
      for (const entry of bag['parent_summaries'] as Json[]) {
        const record = isRecord(entry) ? entry : { summary: entry }
        if (isExpired(record, env)) {
          flags.push('l1_expired')
          continue
        }
        raws.push(memoryRaw('父会话摘要', record, 'l1', next()))
      }
    }
    const taskPrompt = asString(bag['task_prompt'])
    if (taskPrompt !== null) {
      raws.push(inputRaw([textPart(taskPrompt)], PRIORITY.input, 0, next()))
    }
    if (Array.isArray(bag['inbox_unread'])) {
      for (const item of bag['inbox_unread'] as Json[]) {
        if (!isRecord(item)) continue
        const kind = asString(item['kind']) ?? 'instruction'
        const from = asString(item['from']) ?? 'parent'
        const body = asString(item['body']) ?? ''
        raws.push(
          inputRaw([textPart(`[收件箱 ${kind} · 来自 ${from}]\n${body}`)], PRIORITY.memory, parseAt(item['at']), next(), from),
        )
      }
    }
  }

  // 线程：group 的本轮发言者人格 + 圆桌议题
  if (threadKind === 'group') {
    const persona = asString(bag['persona'])
    if (persona !== null) {
      raws.push({
        role: 'system',
        parts: [textPart(`[本轮发言者人格]\n${persona}`)],
        source: 'prompt',
        priority: PRIORITY.prompt,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        orderHint: next(),
      })
    }
    const topic = asString(bag['topic'])
    if (topic !== null) {
      raws.push(inputRaw([textPart(`[圆桌议题]\n${topic}`)], PRIORITY.input, 0, next()))
    }
  }

  // 技能片段
  if (Array.isArray(bag['skills'])) {
    for (const skill of bag['skills'] as Json[]) {
      if (!isRecord(skill)) continue
      const name = asString(skill['name']) ?? asString(skill['id']) ?? ''
      const content = asString(skill['content']) ?? asString(skill['text']) ?? ''
      const title = name.length > 0 ? `技能 ${name}` : '技能'
      raws.push({
        role: 'system',
        parts: [textPart(`[${title}]\n${content}`)],
        source: 'skill',
        priority: PRIORITY.skill,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        orderHint: next(),
      })
    }
  }

  // L3 召回（按分数降序截断；未给分数的按 0）
  const recallEntries: { entry: string; score: number }[] = []
  if (Array.isArray(bag['recall'])) {
    const scored: { parts: CanonicalPart[]; score: number; entry: string; index: number }[] = []
    ;(bag['recall'] as Json[]).forEach((item, index) => {
      if (typeof item === 'string') {
        scored.push({ parts: [textPart(item)], score: 0, entry: item, index })
        return
      }
      if (!isRecord(item)) return
      const score = typeof item['score'] === 'number' && Number.isFinite(item['score']) ? item['score'] : 0
      const entryValue = item['entry']
      const id =
        typeof entryValue === 'string'
          ? entryValue
          : isRecord(entryValue)
            ? asString(entryValue['id']) ?? JSON.stringify(entryValue)
            : asString(item['id']) ?? `recall-${index}`
      const explicitContent = asString(item['content'])
      const text =
        explicitContent ??
        (typeof entryValue === 'string'
          ? entryValue
          : isRecord(entryValue)
            ? entryValue['summary'] !== undefined
              ? renderMemory('召回', entryValue['summary'])
              : JSON.stringify(entryValue)
            : '')
      scored.push({ parts: [textPart(text)], score, entry: id, index })
    })
    scored.sort((left, right) => right.score - left.score || left.index - right.index)
    for (const item of scored) {
      recallEntries.push({ entry: item.entry, score: item.score })
      raws.push({
        role: 'system',
        parts: item.parts,
        source: 'recall',
        priority: PRIORITY.recall,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        orderHint: next(),
      })
    }
  }

  // 历史（workflow 不组装消息历史；group 用群聊 transcript 替换；subagent 只取任务与父检查点，不继承父历史）
  let groupOffset = 0
  if (threadKind !== 'workflow' && threadKind !== 'subagent') {
    const selected = history.chain.slice(history.coveredIndex + 1)
    const historyRaws: RawMessage[] = []
    const historyToolCall: boolean[] = []
    selected.forEach((entry) => {
      const parsed = messageParts(entry.body)
      const role = normalizeRole(entry.body['role'])
      const turnId = messageTurnId(asString(entry.body['id']) ?? entry.hash, turns)
      const from =
        threadKind === 'group' ? asString(entry.body['from']) ?? asString(entry.body['speaker']) : null
      let parts = parsed.parts
      // group 改写 parts（加发言者前缀）后内容已不同于 def：计数 / 规范化缓存键须按改写后内容定，
      // 否则同一 def 在「改写 / 未改写」两形态间串计数与 dedup。
      let tokenKey: string | null = null
      if (from !== null && parts.length > 0 && parts[0]?.type === 'text') {
        parts = [{ type: 'text', text: `${from}: ${(parts[0] as { text: string }).text}` }, ...parts.slice(1)]
        tokenKey = computeTokenKey(parts)
      }
      const at = parseAt(entry.body['at'])
      const error = metaError(entry.body)
      // 展示工具卡提升：assistant 承接帧（调用逐字）+ 各工具结果（机械老化 + 句柄）。
      if (role === 'assistant' && parsed.toolParts.length > 0) {
        const toolCalls: Json = parsed.toolParts.map((tool) => ({
          id: tool.callId,
          name: tool.tool,
          arguments: tool.args,
        }))
        historyRaws.push({
          role: 'assistant',
          parts,
          source: 'history',
          priority: PRIORITY.history,
          at,
          atomic: true,
          atomicGroup: null,
          toolCallId: null,
          toolCalls,
          from,
          orderHint: next(),
          defKey: entry.hash,
          turnId,
          ...(error === null ? {} : { error }),
          ...(tokenKey === null ? {} : { tokenKey }),
        })
        historyToolCall.push(true)
        for (const tool of parsed.toolParts) {
          const pending = tool.status === null && tool.result === null
          if (pending) {
            historyRaws.push({
              role: 'tool',
              parts: [textPart(interruptedResult())],
              source: 'history',
              priority: PRIORITY.history,
              at,
              atomic: true,
              atomicGroup: null,
              toolCallId: tool.callId,
              from: null,
              orderHint: next(),
              defKey: `${entry.hash}\u0001${tool.callId}`,
              turnId,
            })
            historyToolCall.push(false)
            continue
          }
          const ok = tool.status !== 'error'
          const verbatim = JSON.stringify({ call_id: tool.callId, ok, result: tool.result })
          historyRaws.push({
            role: 'tool',
            parts: [textPart(ageResultText(tool.tool, tool.args, tool.callId, tool.result ?? null, ok))],
            source: 'history',
            priority: PRIORITY.history,
            at,
            atomic: true,
            atomicGroup: null,
            toolCallId: tool.callId,
            from: null,
            orderHint: next(),
            defKey: `${entry.hash}\u0001${tool.callId}`,
            turnId,
            toolResult: { tool: tool.tool, args: tool.args, verbatim },
          })
          historyToolCall.push(false)
        }
        return
      }
      historyRaws.push({
        role,
        parts,
        source: 'history',
        priority: PRIORITY.history,
        at,
        atomic: false,
        atomicGroup: null,
        toolCallId: asString(entry.body['tool_call_id']),
        from,
        orderHint: next(),
        defKey: entry.hash,
        turnId,
        ...(error === null ? {} : { error }),
        ...(tokenKey === null ? {} : { tokenKey }),
      })
      historyToolCall.push(parsed.hasToolCall)
    })
    // 历史 atomic 组：工具调用 + 结果同进同出；与后续 extra_messages 组编号区隔。
    const historyGroups = atomicGroups(
      historyRaws.map((raw, index) => ({ parts: raw.parts, role: raw.role, hasToolCall: historyToolCall[index] === true })),
    )
    historyRaws.forEach((raw, index) => {
      raw.atomicGroup = historyGroups[index] ?? null
      raw.atomic = raw.atomicGroup !== null
    })
    raws.push(...historyRaws)
    // extra_messages 的组号从历史之后接续，避免与历史组相撞。
    for (const group of historyGroups) if (group !== null && group + 1 > groupOffset) groupOffset = group + 1
  }

  // 风格
  const style = bag['style']
  const styleText =
    typeof style === 'string'
      ? style
      : isRecord(style)
        ? asString(style['text']) ?? asString(style['content'])
        : null
  if (styleText !== null && styleText.length > 0) {
    raws.push({
      role: 'system',
      parts: [textPart(styleText)],
      source: 'style',
      priority: PRIORITY.style,
      at: 0,
      atomic: false,
      atomicGroup: null,
      toolCallId: null,
      from: null,
      orderHint: next(),
    })
  }

  // 同回合 iter 间产物（工具结果 / verify 报告 / 提问答案）：随 bag.extra_messages 传入，追加到消息尾部。
  // source = `tool`（不在前缀序内 ⇒ 排在本轮输入之后）；priority = 历史级（随历史额度可裁，避免 P0 无界）。
  // assistant(tool_calls) 与它的工具结果编成 atomic 组，同进同出；推理块按中立形态回灌。
  const extraMessages = bag['extra_messages']
  if (Array.isArray(extraMessages)) {
    const extraRaws: RawMessage[] = []
    const extraToolCall: boolean[] = []
    const callsById = new Map<string, { tool: string; args: Json }>()
    for (const item of extraMessages) {
      if (!isRecord(item)) continue
      const toolCalls = Array.isArray(item['tool_calls']) ? (item['tool_calls'] as Json) : null
      if (toolCalls !== null) {
        for (const call of toolCalls) {
          if (!isRecord(call)) continue
          const id = asString(call['id'])
          if (id === null) continue
          callsById.set(id, {
            tool: asString(call['name']) ?? '',
            args: (call['arguments'] ?? null) as Json,
          })
        }
      }
    }
    for (const item of extraMessages) {
      if (!isRecord(item)) continue
      const toolCalls = Array.isArray(item['tool_calls']) ? (item['tool_calls'] as Json) : null
      const parsed = messageParts(item)
      const reasoning = neutralReasoning(item['reasoning'], model)
      // 空 content 的 assistant（只带 tool_calls）不能丢：它是工具调用的承接帧
      if (parsed.parts.length === 0 && (toolCalls === null || toolCalls.length === 0) && reasoning === null) continue
      const role = normalizeRole(item['role'])
      const toolCallId = asString(item['tool_call_id'])
      const error = metaError(item)
      const raw: RawMessage = {
        role,
        parts: parsed.parts,
        source: 'tool',
        priority: PRIORITY.history,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId,
        from: null,
        orderHint: next(),
        ...(toolCalls === null ? {} : { toolCalls }),
        ...(reasoning === null ? {} : { reasoning }),
        ...(error === null ? {} : { error }),
      }
      if (role === 'tool' && toolCallId !== null) {
        const origin = callsById.get(toolCallId)
        if (origin !== undefined) {
          raw.toolResult = {
            tool: origin.tool,
            args: origin.args,
            verbatim: parsed.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
          }
        }
      }
      extraRaws.push(raw)
      extraToolCall.push(toolCalls !== null && toolCalls.length > 0)
    }
    const extraGroups = atomicGroups(
      extraRaws.map((raw, index) => ({ parts: raw.parts, role: raw.role, hasToolCall: extraToolCall[index] === true })),
    )
    extraRaws.forEach((raw, index) => {
      const local = extraGroups[index]
      raw.atomicGroup = local === null ? null : local + groupOffset
      raw.atomic = raw.atomicGroup !== null
    })
    raws.push(...extraRaws)
  }

  return { raws, flags, recallEntries, coveredUpto: history.coveredUpto, l1Valid: history.l1Valid, turns, checkpoint }
}
