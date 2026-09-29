// 回合事件日志的上下文侧元数据（纯函数，不取时间 / 不随机）。
//
// 唯一真源是会话回合日志（`session.turns[].steps`，`session.read` 的切片）；展示投影归 session 所有
// （`session/execute/project.ts`），本模块只提供上下文侧所需：
//   - 回合距离（分层保留）；
//   - 工具调用步号（替代标记引用真实步号）；
//   - 最新结构化检查点与其全局覆盖边界（`{turn_id, seq}`，按回合序 + 步号词序）；
//   - 被边界覆盖的回合 id（T3）。

import { isRecord } from './text.ts'
import type { Json } from './types.ts'

/** 全局覆盖边界：回合 + 步号（词序先比回合序，再比步号）。 */
export interface CoverageBoundary {
  turnId: string
  turnIndex: number
  seq: number
}

export interface CheckpointInfo {
  turn_id: string
  seq: number | null
  summary: Record<string, unknown>
  covered_upto: Json
  boundary: CoverageBoundary
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
  /** 被检查点覆盖、不再逐条回灌的回合 id（边界之前的整回合，T3）。 */
  coveredTurnIds: Set<string>
  /** 全局边界（无结构化检查点则 null）；边界所在回合只覆盖到该步号。 */
  boundary: CoverageBoundary | null
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

/** 结构化检查点判定：非内部标记（段标记 / verify / 子代理结果），且至少有一个结构化字段。 */
export function isStructuredCheckpoint(summary: unknown): summary is Record<string, unknown> {
  if (!isRecord(summary)) return false
  if (summary['kind'] === 'segment' || summary['kind'] === 'verify' || summary['kind'] === 'subagent') return false
  return CHECKPOINT_KEYS.some((key) => summary[key] !== undefined)
}

/**
 * 解析检查点覆盖边界：
 * - 整数 = 局部于检查点自身回合的步号（旧式兼容）；
 * - `{turn_id, seq}` = 全局边界；
 * - 其它（字符串 message id 等）无法映射为词序，回 null（不覆盖）。
 */
function boundaryOf(
  covered: Json,
  checkpointTurnId: string,
  checkpointTurnIndex: number,
  order: string[],
): CoverageBoundary | null {
  if (typeof covered === 'number' && Number.isFinite(covered)) {
    return { turnId: checkpointTurnId, turnIndex: checkpointTurnIndex, seq: covered }
  }
  if (isRecord(covered) && typeof covered['turn_id'] === 'string' && typeof covered['seq'] === 'number') {
    const turnId = covered['turn_id'] as string
    const index = order.indexOf(turnId)
    return { turnId, turnIndex: index >= 0 ? index : checkpointTurnIndex, seq: covered['seq'] as number }
  }
  return null
}

/**
 * 汇总回合日志元数据：距离、步号、最新结构化检查点与全局覆盖边界。
 * 边界按（回合序, 步号）词序：边界之前的整回合整体覆盖，边界所在回合只覆盖到该步号。
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
    const steps = Array.isArray(turn['steps']) ? (turn['steps'] as Json[]) : []
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
      if (step['type'] === 'checkpoint' && isStructuredCheckpoint(step['summary'])) {
        checkpoint = {
          turn_id: turnId,
          seq,
          summary: step['summary'] as Record<string, unknown>,
          covered_upto: (step['covered_upto'] ?? null) as Json,
          boundary: { turnId, turnIndex: index, seq: seq ?? 0 },
        }
        checkpointTurnIndex = index
      }
    }
  })

  const coveredTurnIds = new Set<string>()
  let boundary: CoverageBoundary | null = null
  if (checkpoint !== null && checkpointTurnIndex >= 0) {
    boundary = boundaryOf(checkpoint.covered_upto, checkpoint.turn_id, checkpointTurnIndex, order)
    if (boundary !== null) {
      checkpoint.boundary = boundary
      turns.forEach((turn, index) => {
        const turnId = asString(turn['turn_id'])
        if (turnId === null) return
        if (index < boundary.turnIndex) coveredTurnIds.add(turnId)
      })
    }
  }

  return { distances, order, callStep, checkpoint, coveredTurnIds, boundary }
}

/** 一条（回合, 步号）位置是否被检查点边界覆盖；仅 history 来源的投影记录使用。 */
export function isCovered(metadata: TurnMetadata, turnId: string | null, step: number | null): boolean {
  if (turnId === null) return false
  if (metadata.coveredTurnIds.has(turnId)) return true
  const boundary = metadata.boundary
  if (boundary === null || boundary.turnId !== turnId) return false
  return (step ?? 0) <= boundary.seq
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
