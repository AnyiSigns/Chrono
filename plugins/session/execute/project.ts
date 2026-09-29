// 展示投影（纯函数，展示形状）：唯一真源是会话回合日志（`session.turns[].steps`）。
// 逐回合给出展示时间线（用户文本 / 推理 / 正文 / 工具卡与结果 / 检查点与 verify 标记），
// 以及 UI 消费的展示序消息链（`{hash, def}`，旧 → 新）。只读展示形状：
//   `turn.open.user_message.content/parts/attachments`、`step.result.assistant.content/parts`、
//   `step.result.tool_results`（工具卡状态 / 结果）与 `checkpoint.summary`。
// 不读世界、不取时钟；结果确定。

import type { Json, Rec } from './store.ts'

export interface DisplayMessage {
  hash: string
  def: Rec
}

export interface DisplayTurn {
  turnId: string
  messages: DisplayMessage[]
}

export interface DisplayTimelineItem {
  kind: string
  [key: string]: Json
}

export interface DisplayTurnTimeline {
  turn_id: string
  at: Json
  state: Json
  outcome: Json
  index: number
  items: DisplayTimelineItem[]
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stepsOf(turn: Rec): Rec[] {
  const steps = turn['steps']
  return Array.isArray(steps) ? steps.filter(isRecord) : []
}

function stepSeq(step: Rec): number {
  return typeof step['seq'] === 'number' && Number.isFinite(step['seq']) ? (step['seq'] as number) : 0
}

/** 回合用户消息 def（id 与 `session` 的消息链口径一致）。 */
function userDef(conv: string, turn: Rec): Rec | null {
  const user = isRecord(turn['user_message']) ? turn['user_message'] : null
  if (user === null) return null
  const def: Rec = {
    id: `msg-${conv}-${turn['turn_id'] as string}-user`,
    role: 'user',
    content: asString(user['content']) ?? '',
    at: (turn['at'] ?? null) as Json,
  }
  if (Array.isArray(user['parts'])) def['parts'] = user['parts']
  if (Array.isArray(user['attachments'])) def['attachments'] = user['attachments']
  return def
}

/** 回合最终助手 def：取含内容 / parts 的最大步号 `step.result`（累积全量）。 */
function assistantDef(conv: string, turn: Rec): Rec | null {
  let best: Rec | null = null
  let bestSeq = -1
  for (const step of stepsOf(turn)) {
    if (step['type'] !== 'step.result') continue
    const assistant = isRecord(step['assistant']) ? (step['assistant'] as Rec) : null
    if (assistant === null) continue
    const seq = stepSeq(step)
    if (seq >= bestSeq) {
      bestSeq = seq
      best = assistant
    }
  }
  if (best === null) return null
  const content = asString(best['content'])
  const parts = Array.isArray(best['parts']) ? (best['parts'] as Json[]) : null
  if (content === null && parts === null) return null
  const def: Rec = {
    id: `msg-${conv}-${turn['turn_id'] as string}-assistant`,
    role: 'assistant',
    content: content ?? '',
    at: (turn['at'] ?? null) as Json,
  }
  if (parts !== null) def['parts'] = parts
  return def
}

/** 回合运行中插入的用户消息步（`step.user`），按步号升序。 */
function insertSteps(turn: Rec): Rec[] {
  return stepsOf(turn)
    .filter((step) => step['type'] === 'step.user')
    .sort((a, b) => stepSeq(a) - stepSeq(b))
}

/** 插入的用户消息 def（id 用插入幂等键去重）。 */
function insertDef(conv: string, turn: Rec, step: Rec): Rec | null {
  const message = isRecord(step['user_message']) ? (step['user_message'] as Rec) : null
  if (message === null) return null
  const insertId = asString(step['insert_id']) ?? `${stepSeq(step)}`
  const def: Rec = {
    id: `msg-${conv}-${turn['turn_id'] as string}-user-${insertId}`,
    role: 'user',
    content: asString(message['content']) ?? '',
    at: (message['at'] ?? turn['at'] ?? null) as Json,
  }
  if (Array.isArray(message['parts'])) def['parts'] = message['parts']
  if (Array.isArray(message['attachments'])) def['attachments'] = message['attachments']
  return def
}

/** 展示序消息链（旧 → 新），按回合分组；`prev` 跨回合串成链。 */
export function displayMessagesByTurn(conv: string, turns: Rec[]): DisplayTurn[] {
  const groups: DisplayTurn[] = []
  let prev: string | null = null
  for (const turn of turns) {
    const turnId = asString(turn['turn_id'])
    if (turnId === null) continue
    const messages: DisplayMessage[] = []
    const push = (def: Rec | null): void => {
      if (def === null) return
      def['prev'] = prev === null ? null : { def: prev }
      prev = def['id'] as string
      messages.push({ hash: def['id'] as string, def })
    }
    push(userDef(conv, turn))
    // 回合运行中插入的用户消息：落在本回合用户消息之后、最终助手之前（展示链可表达的位置）。
    for (const step of insertSteps(turn)) push(insertDef(conv, turn, step))
    push(assistantDef(conv, turn))
    groups.push({ turnId, messages })
  }
  return groups
}

/** 结构化摘要渲染成确定文本（缺字段跳过）。 */
function renderSummary(summary: Rec): string {
  const lines: string[] = []
  const goal = asString(summary['goal'])
  if (goal !== null) lines.push(`目标：${goal}`)
  const list = (key: string, label: string): void => {
    const value = summary[key]
    if (!Array.isArray(value) || value.length === 0) return
    lines.push(`${label}：`)
    for (const item of value) {
      const text = itemText(item)
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

function itemText(item: unknown): string | null {
  if (typeof item === 'string') return item.length > 0 ? item : null
  if (!isRecord(item)) return null
  for (const key of ['what', 'claim', 'path', 'step', 'text', 'summary']) {
    const value = item[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

const STRUCTURED_KEYS = [
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

function isStructuredCheckpoint(summary: Rec): boolean {
  if (summary['kind'] === 'segment' || summary['kind'] === 'verify' || summary['kind'] === 'subagent') return false
  return STRUCTURED_KEYS.some((key) => summary[key] !== undefined)
}

/** 回合展示时间线：用户文本 / 推理 / 正文 / 工具卡 / 检查点与 verify 标记。 */
export function displayTimeline(turns: Rec[]): DisplayTurnTimeline[] {
  const out: DisplayTurnTimeline[] = []
  turns.forEach((turn, index) => {
    const turnId = asString(turn['turn_id']) ?? ''
    const items: DisplayTimelineItem[] = []
    const user = isRecord(turn['user_message']) ? turn['user_message'] : null
    const userText = user !== null ? asString(user['content']) : null
    if (userText !== null) items.push({ kind: 'user', text: userText })
    // 回合运行中插入的用户消息：时间线里作为用户条目按步号落位。
    for (const step of insertSteps(turn)) {
      const message = isRecord(step['user_message']) ? (step['user_message'] as Rec) : null
      const text = message !== null ? asString(message['content']) : null
      if (text !== null) items.push({ kind: 'user', text })
    }

    // 最终助手展示 parts（reasoning / text / tool 按到达序）。
    let best: Rec | null = null
    let bestSeq = -1
    for (const step of stepsOf(turn)) {
      if (step['type'] !== 'step.result') continue
      const assistant = isRecord(step['assistant']) ? (step['assistant'] as Rec) : null
      if (assistant === null) continue
      const parts = Array.isArray(assistant['parts']) ? (assistant['parts'] as Json[]) : []
      const hasContent = typeof assistant['content'] === 'string' && assistant['content'].length > 0
      if ((parts.length > 0 || hasContent) && stepSeq(step) >= bestSeq) {
        bestSeq = stepSeq(step)
        best = assistant
      }
    }
    const parts = best !== null && Array.isArray(best['parts']) ? (best['parts'] as Json[]) : []
    if (parts.length === 0 && best !== null && typeof best['content'] === 'string' && best['content'].length > 0) {
      items.push({ kind: 'text', text: best['content'] as string })
    }
    for (const part of parts) {
      if (!isRecord(part)) continue
      const type = part['type']
      if (type === 'reasoning' && typeof part['text'] === 'string') {
        items.push({ kind: 'reasoning', text: part['text'] as string })
        continue
      }
      if (type === 'text' && typeof part['text'] === 'string') {
        items.push({ kind: 'text', text: part['text'] as string })
        continue
      }
      if (type === 'tool') {
        items.push({
          kind: 'tool',
          call_id: (part['call_id'] ?? null) as Json,
          tool: (part['tool'] ?? '') as Json,
          args: (part['args'] ?? null) as Json,
          render: (part['render'] ?? null) as Json,
          result: (part['result'] ?? null) as Json,
          status: (part['status'] ?? null) as Json,
        })
      }
    }

    // 检查点 / verify / 子代理标记。
    for (const step of stepsOf(turn)) {
      if (step['type'] !== 'checkpoint') continue
      const summary = isRecord(step['summary']) ? step['summary'] : null
      if (summary === null) continue
      if (summary['kind'] === 'segment') continue
      if (summary['kind'] === 'verify') {
        const text = asString(summary['text'])
        if (text !== null) items.push({ kind: 'verify', text })
        continue
      }
      if (summary['kind'] === 'subagent') {
        const text = renderSummary(summary)
        if (text.length > 0) items.push({ kind: 'subagent', text })
        continue
      }
      if (isStructuredCheckpoint(summary)) {
        const text = renderSummary(summary)
        if (text.length > 0) items.push({ kind: 'checkpoint', text })
      }
    }

    out.push({
      turn_id: turnId,
      at: (turn['at'] ?? null) as Json,
      state: (turn['state'] ?? null) as Json,
      outcome: (turn['outcome'] ?? null) as Json,
      index,
      items,
    })
  })
  return out
}
