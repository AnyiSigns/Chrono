// 回合事件日志的上下文侧元数据（纯函数，不取时间 / 不随机）。
//
// 唯一真源是会话回合日志（`session.turns[].steps`，`session.read` 的切片）；展示投影归 session 所有
// （`session/execute/project.ts`），本模块只提供上下文侧所需：
//   - 回合距离（分层保留）；
//   - 工具调用步号（替代标记引用真实步号）。

import { isRecord } from './text.ts'

export interface TurnMetadata {
  /** 回合 id → 距最新回合的距离（0 = 最新）。 */
  distances: Map<string, number>
  /** 回合 id，旧 → 新。 */
  order: string[]
  /** 工具调用 id → 落账步号（step.intent.seq）。 */
  callStep: Map<string, number>
}

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

/** 汇总回合日志元数据：距离与工具调用步号。 */
export function turnMetadata(session: Record<string, unknown>): TurnMetadata {
  const turns = turnsOf(session)
  const distances = new Map<string, number>()
  const order: string[] = []
  const callStep = new Map<string, number>()

  turns.forEach((turn, index) => {
    const turnId = asString(turn['turn_id'])
    if (turnId === null) return
    order.push(turnId)
    distances.set(turnId, turns.length - 1 - index)
    const steps = Array.isArray(turn['steps']) ? (turn['steps'] as unknown[]) : []
    for (const step of steps) {
      if (!isRecord(step)) continue
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
    }
  })

  return { distances, order, callStep }
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
