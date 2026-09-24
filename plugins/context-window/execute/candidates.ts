// 流水线第 0 / 0b / 1 步：候选汇集、L1 TTL 过滤、结构化 → 规范消息（RawMessage）。
// 一切输入随 bag 由调用方入口 term 装配传入（服务不读投影）；本轮用户消息 / 系统提示 / 工具 schema /
// L2 / 上一会话 L1 / 本会话 L1 / 技能 / L3 召回 / 历史 / 风格；线程口径按 bag.thread_kind 调输入。

import { atomicGroups, messageParts, normalizeRole, planHistory } from './history.ts'
import { computeTokenKey, isRecord, parseAt, parseExpiresAt, renderMemory } from './text.ts'
import type { CallEnv, CanonicalPart, Json, RawMessage } from './types.ts'

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
}

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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
    subject: asString(entry['subject']),
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
    subject: null,
    orderHint,
  }
}

/** 汇集候选并结构化（第 0 / 0b / 1 步）。 */
export function gatherCandidates(bag: Record<string, unknown>, env: CallEnv): Gathered {
  const raws: RawMessage[] = []
  const flags: string[] = []
  const history = planHistory(bag)
  if (!history.l1Valid) flags.push('l1_invalid')

  const memories = isRecord(bag['memories']) ? bag['memories'] : {}
  const threadKind = asString(bag['thread_kind']) ?? 'main'
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
      subject: null,
      orderHint: next(),
    })
  }

  // 工具 schema（每个工具一条，保持 bag 顺序 = 稳定前缀）
  if (Array.isArray(bag['tools'])) {
    for (const tool of bag['tools'] as Json[]) {
      if (!isRecord(tool)) continue
      const name = asString(tool['name']) ?? ''
      const schema = isRecord(tool['schema']) ? (tool['schema'] as Json) : tool
      const description = asString(tool['description'])
      const body: Record<string, Json> = { name }
      if (description !== null) body['description'] = description
      if (schema !== null) body['schema'] = schema
      raws.push({
        role: 'system',
        parts: [textPart(JSON.stringify(body))],
        source: 'tools',
        priority: PRIORITY.tools,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: null,
        subject: null,
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

  // 线程：subagent 的父摘要 / 任务提示词 / 未读收件箱
  if (threadKind === 'subagent') {
    if (Array.isArray(bag['parent_summaries'])) {
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
        subject: null,
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
        subject: null,
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
        subject: null,
        orderHint: next(),
      })
    }
  }

  // 历史（workflow 不组装消息历史；group 用群聊 transcript 替换）
  if (threadKind !== 'workflow') {
    const selected = history.chain.slice(history.coveredIndex + 1)
    const groupFlags = atomicGroups(
      selected.map((entry) => {
        const parsed = messageParts(entry.body)
        return { parts: parsed.parts, role: normalizeRole(entry.body['role']), hasToolCall: parsed.hasToolCall }
      }),
    )
    selected.forEach((entry, index) => {
      const from =
        threadKind === 'group' ? asString(entry.body['from']) ?? asString(entry.body['speaker']) : null
      let parts = messageParts(entry.body).parts
      // group 改写 parts（加发言者前缀）后内容已不同于 def：计数 / 规范化缓存键须按改写后内容定，
      // 否则同一 def 在「改写 / 未改写」两形态间串计数与 dedup。
      let tokenKey: string | null = null
      if (from !== null && parts.length > 0 && parts[0]?.type === 'text') {
        parts = [{ type: 'text', text: `${from}: ${(parts[0] as { text: string }).text}` }, ...parts.slice(1)]
        tokenKey = computeTokenKey(parts)
      }
      raws.push({
        role: normalizeRole(entry.body['role']),
        parts,
        source: 'history',
        priority: PRIORITY.history,
        at: parseAt(entry.body['at']),
        atomic: groupFlags[index] !== null,
        atomicGroup: groupFlags[index],
        toolCallId: asString(entry.body['tool_call_id']),
        from,
        subject: null,
        orderHint: index,
        defKey: entry.hash,
        ...(tokenKey === null ? {} : { tokenKey }),
      })
    })
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
      subject: null,
      orderHint: next(),
    })
  }

  // 同回合 iter 间产物（工具结果 / verify 报告 / 提问答案）：随 bag.extra_messages 传入，追加到消息尾部。
  // source = `tool`（不在前缀序内 ⇒ 排在本轮输入之后）；priority = 历史级（随历史额度可裁，避免 P0 无界）。
  const extraMessages = bag['extra_messages']
  if (Array.isArray(extraMessages)) {
    for (const item of extraMessages) {
      if (!isRecord(item)) continue
      const toolCalls = Array.isArray(item['tool_calls']) ? (item['tool_calls'] as Json) : null
      const parsed = messageParts(item)
      // 空 content 的 assistant（只带 tool_calls）不能丢：它是工具调用的承接帧
      if (parsed.parts.length === 0 && (toolCalls === null || toolCalls.length === 0)) continue
      raws.push({
        role: normalizeRole(item['role']),
        parts: parsed.parts,
        source: 'tool',
        priority: PRIORITY.history,
        at: 0,
        atomic: false,
        atomicGroup: null,
        toolCallId: asString(item['tool_call_id']),
        toolCalls,
        from: null,
        subject: null,
        orderHint: next(),
      })
    }
  }

  return { raws, flags, recallEntries, coveredUpto: history.coveredUpto, l1Valid: history.l1Valid }
}
