// 回合事件日志的两个对等投影（纯函数，均不取时间 / 不随机）。
//
//   view.display —— 给 UI：逐回合的完整时间线（用户消息 / 推理块 / 正文 / 工具卡与结果），
//                   展示保真优先，不受上下文预算裁剪。
//   view.context —— 给模型：分层保留后的消息列（由组装流水线产出；本模块提供它所需的回合元数据：
//                   回合距离、工具调用步号、结构化检查点与其覆盖边界）。
//
// 两者同源于会话回合日志（`session.turns[].steps`，`session.read` 的切片），不读世界。

import { isRecord } from './text.ts'
import type { Json } from './types.ts'

export interface CheckpointInfo {
  turn_id: string
  seq: number | null
  summary: Record<string, unknown>
  covered_upto: Json
}

export interface TurnMetadata {
  /** 回合 id → 距最新回合的距离（0 = 最新）。 */
  distances: Map<string, number>
  /** 回合 id，旧 → 新。 */
  order: string[]
  /** 工具调用 id → 落账步号（step.intent.seq）。 */
  callStep: Map<string, number>
  /** 最新结构化检查点（无则 null）。 */
  checkpoint: CheckpointInfo | null
  /** 被检查点覆盖、不再逐条回灌的回合 id（T3）。 */
  coveredTurnIds: Set<string>
}

const CHECKPOINT_KEYS = [
  'goal',
  'constraints',
  'decisions',
  'findings',
  'files',
  'open_questions',
  'next_steps',
  'errors_to_avoid',
  'user_preferences',
] as const

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stepSeq(record: Record<string, unknown>): number | null {
  const seq = record['seq']
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
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

/** 结构化检查点判定：非内部标记（段标记 / verify 报告），且至少有一个结构化字段。 */
export function isStructuredCheckpoint(summary: unknown): summary is Record<string, unknown> {
  if (!isRecord(summary)) return false
  if (summary['kind'] === 'segment' || summary['kind'] === 'verify') return false
  return CHECKPOINT_KEYS.some((key) => summary[key] !== undefined)
}

/**
 * 汇总回合日志元数据：距离、步号、最新结构化检查点与覆盖边界。
 * 覆盖边界按「回合 + 步号」词序：检查点所在回合若其全部步号 ≤ `covered_upto`，该回合整体覆盖；
 * 更早的回合一律覆盖。被覆盖回合不再逐条回灌，由检查点替代。
 */
export function turnMetadata(session: Record<string, unknown>): TurnMetadata {
  const turns = turnsOf(session)
  const distances = new Map<string, number>()
  const order: string[] = []
  const callStep = new Map<string, number>()
  let checkpoint: CheckpointInfo | null = null
  let checkpointTurnIndex = -1

  turns.forEach((turn, index) => {
    const turnId = asString(turn['turn_id'])
    if (turnId === null) return
    order.push(turnId)
    distances.set(turnId, turns.length - 1 - index)
    for (const step of stepsOf(turn)) {
      const seq = stepSeq(step)
      if (step['type'] === 'step.intent' && seq !== null) {
        const calls = step['tool_calls']
        if (Array.isArray(calls)) {
          for (const call of calls) {
            if (!isRecord(call)) continue
            const id = asString(call['id'])
            if (id !== null && !callStep.has(id)) callStep.set(id, seq)
          }
        }
      }
      if (step['type'] === 'checkpoint' && isStructuredCheckpoint(step['summary'])) {
        checkpoint = {
          turn_id: turnId,
          seq,
          summary: step['summary'] as Record<string, unknown>,
          covered_upto: (step['covered_upto'] ?? null) as Json,
        }
        checkpointTurnIndex = index
      }
    }
  })

  const coveredTurnIds = new Set<string>()
  if (checkpoint !== null && checkpointTurnIndex >= 0) {
    const covered = checkpoint
    const maxSeqOf = (turn: Record<string, unknown>): number | null => {
      let max: number | null = null
      for (const step of stepsOf(turn)) {
        const seq = stepSeq(step)
        if (seq !== null && (max === null || seq > max)) max = seq
      }
      return max
    }
    turns.forEach((turn, index) => {
      const turnId = asString(turn['turn_id'])
      if (turnId === null) return
      if (index < checkpointTurnIndex) {
        coveredTurnIds.add(turnId)
        return
      }
      if (index === checkpointTurnIndex && typeof covered.covered_upto === 'number') {
        const maxSeq = maxSeqOf(turn)
        if (maxSeq !== null && maxSeq <= covered.covered_upto) coveredTurnIds.add(turnId)
      }
    })
  }

  return { distances, order, callStep, checkpoint, coveredTurnIds }
}

/** 从消息 id（`msg-<conv>-<turn_id>-<role>`）还原所属回合 id。 */
export function messageTurnId(id: string, metadata: TurnMetadata): string | null {
  if (!id.startsWith('msg-')) return null
  for (const turnId of metadata.order) {
    if (
      id.endsWith(`-${turnId}-user`) ||
      id.endsWith(`-${turnId}-assistant`) ||
      id.endsWith(`-${turnId}-system`)
    ) {
      return turnId
    }
  }
  return null
}

/** 检查点结构化摘要渲染成确定文本（缺字段跳过）。 */
export function renderCheckpoint(summary: Record<string, unknown>): string {
  const lines: string[] = []
  const goal = asString(summary['goal'])
  if (goal !== null) lines.push(`目标：${goal}`)
  const list = (key: string, label: string): void => {
    const value = summary[key]
    if (!Array.isArray(value) || value.length === 0) return
    lines.push(`${label}：`)
    for (const item of value) {
      const text = renderCheckpointItem(item)
      if (text !== null) lines.push(`- ${text}`)
    }
  }
  list('constraints', '约束')
  list('decisions', '决策')
  list('findings', '发现')
  list('files', '涉及文件')
  list('open_questions', '未决问题')
  list('next_steps', '下一步')
  list('errors_to_avoid', '应避免的错误')
  list('user_preferences', '用户偏好')
  return lines.join('\n')
}

function renderCheckpointItem(item: unknown): string | null {
  if (typeof item === 'string') return item.length > 0 ? item : null
  if (!isRecord(item)) return null
  const what = asString(item['what']) ?? asString(item['claim']) ?? asString(item['path']) ?? asString(item['step'])
  if (what === null) return null
  const why = asString(item['why'])
  const state = asString(item['state'])
  const summary = asString(item['summary'])
  const suffix = [state, summary, why].filter((value): value is string => value !== null).join(' · ')
  return suffix.length > 0 ? `${what}（${suffix}）` : what
}

/**
 * `view.display`：给 UI 的完整投影。逐回合给出用户消息与最终助手时间线
 * （推理块 / 正文 / 工具卡与结果按到达序），不受预算裁剪。
 * 回合日志不记逐步墙钟，`at` 为回合级时间，逐步用量随 `step.result.usage` 带出。
 */
export function displayView(session: Record<string, unknown>): Json {
  const refs = isRecord(session['refs']) ? (session['refs'] as Record<string, unknown>) : {}
  const turns = turnsOf(session)
  const out: Json[] = []
  turns.forEach((turn, index) => {
    const turnId = asString(turn['turn_id']) ?? ''
    const user = findTurnUserMessage(refs, turnId)
    const parts = finalAssistantParts(turn)
    const items: Json[] = []
    if (user !== null) items.push({ kind: 'user', text: user })
    for (const part of parts) {
      if (!isRecord(part)) continue
      const type = part['type']
      if (type === 'reasoning' && typeof part['text'] === 'string') {
        items.push({ kind: 'reasoning', text: part['text'] })
        continue
      }
      if (type === 'text' && typeof part['text'] === 'string') {
        items.push({ kind: 'text', text: part['text'] })
        continue
      }
      if (type === 'tool') {
        items.push({
          kind: 'tool',
          call_id: part['call_id'] ?? null,
          tool: part['tool'] ?? '',
          args: (part['args'] ?? null) as Json,
          render: (part['render'] ?? null) as Json,
          result: (part['result'] ?? null) as Json,
          status: part['status'] ?? null,
        })
      }
    }
    out.push({
      turn_id: turnId,
      at: turn['at'] ?? null,
      state: turn['state'] ?? null,
      outcome: (turn['outcome'] ?? null) as Json,
      index,
      items,
    })
  })
  return out as Json
}

function findTurnUserMessage(refs: Record<string, unknown>, turnId: string): string | null {
  if (turnId.length === 0) return null
  for (const [id, body] of Object.entries(refs)) {
    if (!isRecord(body)) continue
    if (body['role'] !== 'user') continue
    if (id.startsWith('msg-') && id.endsWith(`-${turnId}-user`)) {
      const content = body['content']
      return typeof content === 'string' ? content : null
    }
  }
  return null
}

/** 回合最终助手时间线：取含 `parts` 的最大步号 `step.result`（其 parts 为该回合累积全量）。 */
function finalAssistantParts(turn: Record<string, unknown>): Json[] {
  let bestSeq = -1
  let best: Json[] = []
  for (const step of stepsOf(turn)) {
    if (step['type'] !== 'step.result') continue
    const seq = stepSeq(step) ?? 0
    const assistant = isRecord(step['assistant']) ? (step['assistant'] as Record<string, unknown>) : null
    const parts = assistant !== null && Array.isArray(assistant['parts']) ? (assistant['parts'] as Json[]) : []
    if (parts.length > 0 && seq >= bestSeq) {
      bestSeq = seq
      best = parts
    }
  }
  return best
}
