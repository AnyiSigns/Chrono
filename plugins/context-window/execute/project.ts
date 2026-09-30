// 上下文投影（纯函数，模型形状）：唯一真源是会话回合日志（`session.turns[].steps`）。
// 只读模型形状字段：`turn.open.user_message.content/attachments`、`step.intent.kind==='tool.dispatch'`
// + `step.intent.tool_calls`、`step.result.assistant.content`、`step.result.tool_results`、
// `step.result.reasoning`（厂商中立块）与 `checkpoint.summary`。
// **不读** 展示 parts / 工具卡 / `refs`——展示投影归 session 所有（`session/execute/project.ts`）。
//
// 产物为中性模型记录（尚未赋来源 / 优先级 / 序号），确定性顺序：
//   每回合：user 消息；每个派发批次：assistant(content, tool_calls) 后跟各 tool(call_id, JSON 结果)；
//   无调用的 step.result：assistant 正文；verify：一条 system 记录；
//   子代理结果：一条 system 记录（同回合可见，不构成会话边界）。
// assistant + 其工具结果编成同一 atomic 组（同进同出），供保留 / 预算按组处理。
//
// 来源口径（`currentTurnId` = 调用方下传的本轮回合 id，缺省 null）：
//   本轮用户消息不投影（`bag.input` 是权威来源，避免历史副本夺走 P0 `input` 地位）；
//   本轮非用户记录（assistant / tool / verify / 子代理）标 `source:'tool'`（排序落在 input 之后、保留恒 T0）；
//   往期回合仍标 `source:'history'`。
// verify / 子代理以 `role:'system'` 回灌——tool 角色必须带 `tool_call_id`，无调用 id 的 tool 记录是非法厂商消息。

import { parseAttachments } from './history.ts'
import { isRecord, parseAt } from './text.ts'
import { renderCheckpoint, type TurnMetadata } from './views.ts'
import type { CanonicalPart, Json, Role, Source, ToolResultMeta } from './types.ts'

export interface ProjectedRecord {
  role: Role
  parts: CanonicalPart[]
  source: Source
  priority: number
  toolCalls: Json | null
  toolCallId: string | null
  toolResult: ToolResultMeta | null
  reasoning: Json | null
  error: string | null
  turnId: string | null
  step: number | null
  at: number
  /** atomic 组号（assistant 与其工具结果同组）；非组内为 null。 */
  group: number | null
  /** 群聊发言者（缺省 null）。 */
  from: string | null
}

export interface ProjectedContext {
  records: ProjectedRecord[]
}

const HISTORY_PRIORITY = 4

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function turnsOf(session: Record<string, unknown>): Record<string, unknown>[] {
  const turns = session['turns']
  if (!Array.isArray(turns)) return []
  return turns.filter(isRecord)
}

function stepsOf(turn: Record<string, unknown>): Record<string, unknown>[] {
  const steps = turn['steps']
  if (!Array.isArray(steps)) return []
  return steps.filter(isRecord)
}

/** 用户消息的模型形状 parts：content + attachments（不读展示 parts）。 */
function userParts(message: Record<string, unknown>): CanonicalPart[] {
  const parts: CanonicalPart[] = []
  const content = asString(message['content'])
  if (content !== null) parts.push(textPart(content))
  parts.push(...parseAttachments(message['attachments']))
  return parts
}

/** 中立工具调用 → `{id,name,arguments}`（契约形状）。 */
function toolCallsOf(step: Record<string, unknown>): Record<string, unknown>[] {
  const calls = step['tool_calls']
  if (!Array.isArray(calls)) return []
  const out: Record<string, unknown>[] = []
  for (const call of calls) {
    if (!isRecord(call)) continue
    const id = asString(call['id']) ?? asString(call['call_id'])
    if (id === null) continue
    out.push({
      id,
      name: asString(call['name']) ?? asString(call['tool']) ?? '',
      arguments: isRecord(call['arguments']) ? call['arguments'] : (isRecord(call['args']) ? call['args'] : {}),
    })
  }
  return out
}

/**
 * 工具结果的模型形状回灌文本 `{call_id, ok, result|error}`。
 * 失败若另带 `result`（如 `tool-shell` 非零退出回带的 stdout / exit_code）一并回灌——
 * 否则模型只见错误码、看不到具体报错。
 */
function toolResultContent(result: Record<string, unknown>, callId: string): string {
  const ok = result['ok'] !== false
  if (ok) return JSON.stringify({ call_id: callId, ok: true, result: result['result'] ?? null })
  const envelope: Record<string, unknown> = { call_id: callId, ok: false, error: result['error'] ?? null }
  if (Object.hasOwn(result, 'result')) envelope['result'] = result['result']
  return JSON.stringify(envelope)
}

function resultCallId(result: Record<string, unknown>, index: number): string {
  return asString(result['call_id']) ?? `call-${index}`
}

/** 单个 step.result 的工具结果记录（供批次内按 seq 取用）。 */
function toolResultsOf(step: Record<string, unknown>): Record<string, unknown>[] {
  const results = step['tool_results']
  return Array.isArray(results) ? results.filter(isRecord) : []
}

/**
 * 把会话回合日志投影为中性模型记录。`currentTurnId` 给定时，跳过该回合用户消息并让其余记录
 * 走本轮口径（`source:'tool'`）；缺省则全部按历史投影（无回合身份可依时不做猜测）。
 */
export function projectContext(
  session: Record<string, unknown>,
  _metadata: TurnMetadata,
  currentTurnId: string | null = null,
): ProjectedContext {
  const turns = turnsOf(session)
  const records: ProjectedRecord[] = []
  let group = 0

  turns.forEach((turn) => {
    const turnId = asString(turn['turn_id'])
    if (turnId === null) return
    const at = parseAt(turn['at'])
    const from = isRecord(turn['user_message']) ? asString((turn['user_message'] as Record<string, unknown>)['from']) : null
    const isCurrent = currentTurnId !== null && turnId === currentTurnId
    // 本轮非用户记录 = tool 来源（落在 input 之后，保留恒 T0）；往期 = history。
    const origin: Source = isCurrent ? 'tool' : 'history'

    const push = (record: ProjectedRecord): void => {
      records.push(record)
    }
    // 工具结果按 `call_id` 原位覆盖（**仅限本回合**：`call_id` 由模型生成，跨回合可能重名）：
    // 挂起步先落 pending 结果，作答步再落 answers（同一调用两条 step.result）。若各追加一条 tool 记录，
    // 同一 `tool_call_id` 会出现两条结果——厂商适配器只认第一条（pending），作答结果被当成孤立消息丢弃，
    // 模型永远看不到答案（`restoreFromSteps` 有此覆盖，投影侧此前缺失）。
    const toolRecordAt = new Map<string, number>()
    // 同一 `call_id` 的结果原位覆盖（保留首次所在的原子组与工具名 / 参数）。
    const pushTool = (record: ProjectedRecord, callId: string): void => {
      const existing = toolRecordAt.get(callId)
      if (existing !== undefined) {
        const previous = records[existing] as ProjectedRecord
        const previousResult = isRecord(previous.toolResult) ? previous.toolResult : null
        const nextResult = isRecord(record.toolResult) ? record.toolResult : null
        const merged: ProjectedRecord = {
          ...record,
          group: record.group ?? previous.group,
        }
        if (nextResult !== null && previousResult !== null) {
          merged.toolResult = {
            tool: nextResult['tool'] !== '' ? nextResult['tool'] : previousResult['tool'],
            args: nextResult['tool'] !== '' ? nextResult['args'] : previousResult['args'],
            verbatim: nextResult['verbatim'],
          } as ProjectedRecord['toolResult']
        }
        records[existing] = merged
        return
      }
      toolRecordAt.set(callId, records.length)
      records.push(record)
    }

    // 用户消息（turn.open.user_message）。本轮回合的用户消息不投影：`bag.input` 是权威来源。
    if (!isCurrent && isRecord(turn['user_message'])) {
      const parts = userParts(turn['user_message'])
      if (parts.length > 0) {
        push({
          role: 'user',
          parts,
          source: 'history',
          priority: HISTORY_PRIORITY,
          toolCalls: null,
          toolCallId: null,
          toolResult: null,
          reasoning: null,
          error: null,
          turnId,
          step: 0,
          at,
          group: null,
          from,
        })
      }
    }

    const steps = stepsOf(turn)
    const resultBySeq = new Map<number, Record<string, unknown>>()
    const intentSeqs = new Set<number>()
    for (const step of steps) {
      const seq = typeof step['seq'] === 'number' ? (step['seq'] as number) : null
      if (seq !== null && step['type'] === 'step.result') resultBySeq.set(seq, step)
      if (seq !== null && step['type'] === 'step.intent' && step['kind'] === 'tool.dispatch') intentSeqs.add(seq)
    }

    for (const step of steps) {
      const seq = typeof step['seq'] === 'number' ? (step['seq'] as number) : null
      const type = step['type']

      if (type === 'step.intent') {
        if (step['kind'] !== 'tool.dispatch') continue
        const calls = toolCallsOf(step)
        const result = seq !== null ? resultBySeq.get(seq) ?? null : null
        const assistant = result !== null && isRecord(result['assistant']) ? (result['assistant'] as Record<string, unknown>) : null
        const content = assistant !== null ? asString(assistant['content']) : null
        const reasoning = result !== null && result['reasoning'] !== undefined ? (result['reasoning'] as Json) : null
        const batchGroup = group
        group += 1
        if (calls.length > 0 || content !== null) {
          const parts: CanonicalPart[] = content !== null ? [textPart(content)] : []
          push({
            role: 'assistant',
            parts,
            source: origin,
            priority: HISTORY_PRIORITY,
            toolCalls: calls.length > 0 ? (calls as unknown as Json) : null,
            toolCallId: null,
            toolResult: null,
            reasoning,
            error: null,
            turnId,
            step: seq,
            at,
            group: calls.length > 0 ? batchGroup : null,
            from: asString(assistant?.['from']),
          })
        }
        const results = result !== null ? toolResultsOf(result) : []
        results.forEach((resultItem, index) => {
          const callId = resultCallId(resultItem, index)
          const verbatim = toolResultContent(resultItem, callId)
          const call = calls.find((item) => item['id'] === callId) ?? null
          pushTool({
            role: 'tool',
            parts: [textPart(verbatim)],
            source: origin,
            priority: HISTORY_PRIORITY,
            toolCalls: null,
            toolCallId: callId,
            toolResult: {
              tool: call !== null ? asString(call['name']) ?? '' : '',
              args: (call !== null ? call['arguments'] : null) as Json,
              verbatim,
            },
            reasoning: null,
            error: null,
            turnId,
            step: seq,
            at,
            group: batchGroup,
            from: null,
          }, callId)
        })
        continue
      }

      if (type === 'step.result') {
        if (seq !== null && intentSeqs.has(seq)) continue
        const assistant = isRecord(step['assistant']) ? (step['assistant'] as Record<string, unknown>) : null
        const content = assistant !== null ? asString(assistant['content']) : null
        const reasoning = step['reasoning'] !== undefined ? (step['reasoning'] as Json) : null
        if (content !== null || reasoning !== null) {
          push({
            role: 'assistant',
            parts: content !== null ? [textPart(content)] : [],
            source: origin,
            priority: HISTORY_PRIORITY,
            toolCalls: null,
            toolCallId: null,
            toolResult: null,
            reasoning,
            error: null,
            turnId,
            step: seq,
            at,
            group: null,
            from: asString(assistant?.['from']),
          })
        }
        toolResultsOf(step).forEach((resultItem, index) => {
          const callId = resultCallId(resultItem, index)
          const verbatim = toolResultContent(resultItem, callId)
          pushTool({
            role: 'tool',
            parts: [textPart(verbatim)],
            source: origin,
            priority: HISTORY_PRIORITY,
            toolCalls: null,
            toolCallId: callId,
            toolResult: { tool: '', args: null, verbatim },
            reasoning: null,
            error: null,
            turnId,
            step: seq,
            at,
            group: null,
            from: null,
          }, callId)
        })
        continue
      }

      if (type === 'step.user') {
        const message = isRecord(step['user_message']) ? (step['user_message'] as Record<string, unknown>) : null
        if (message !== null) {
          const parts = userParts(message)
          if (parts.length > 0) {
            push({
              role: 'user',
              parts,
              source: origin,
              priority: HISTORY_PRIORITY,
              toolCalls: null,
              toolCallId: null,
              toolResult: null,
              reasoning: null,
              error: null,
              turnId,
              step: seq,
              at,
              group: null,
              from: asString(message['from']),
            })
          }
        }
        continue
      }

      if (type === 'checkpoint') {
        const summary = isRecord(step['summary']) ? (step['summary'] as Record<string, unknown>) : null
        if (summary === null) continue
        const kind = summary['kind']
        if (kind === 'segment') continue
        if (kind === 'verify') {
          const text = asString(summary['text'])
          if (text !== null) {
            push(verifyRecord(text, turnId, seq, at, origin))
          }
          continue
        }
        if (kind === 'subagent') {
          const text = renderCheckpoint(summary)
          if (text.trim().length > 0) {
            push(subagentRecord(`[子代理]\n${text}`, turnId, seq, at, origin))
          }
          continue
        }
        continue
      }
    }
  })

  return { records }
}

/**
 * verify 报告记录。以 `role:'system'` 回灌：tool 角色必须携带 `tool_call_id`，verify 无调用可配对，
 * 若标 tool 会产出无 id 的非法厂商消息（或被迫合成孤立结果）。system + 稳定来源最安全。
 */
function verifyRecord(
  text: string,
  turnId: string,
  step: number | null,
  at: number,
  source: Source,
): ProjectedRecord {
  return {
    role: 'system',
    parts: [textPart(text)],
    source,
    priority: HISTORY_PRIORITY,
    toolCalls: null,
    toolCallId: null,
    toolResult: null,
    reasoning: null,
    error: null,
    turnId,
    step,
    at,
    group: null,
    from: null,
  }
}

function subagentRecord(
  text: string,
  turnId: string,
  step: number | null,
  at: number,
  source: Source,
): ProjectedRecord {
  return {
    role: 'system',
    parts: [textPart(text)],
    source,
    priority: HISTORY_PRIORITY,
    toolCalls: null,
    toolCallId: null,
    toolResult: null,
    reasoning: null,
    error: null,
    turnId,
    step,
    at,
    group: null,
    from: null,
  }
}
