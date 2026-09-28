// 子代理隔离：子代理的上下文由「任务 + 父检查点」构成（不是父消息历史），
// 返回值是结构化结果（与 `checkpoint` 步记录的 `summary` 同形），不是自己的全程记录。
// 父回合只吸收蒸馏后的结论，长任务里这是最便宜的上下文节省。

import { isRecord } from './plan.ts'
import { turnSteps } from './reconstruct.ts'
import type { Json, Rec } from './types.ts'

/** 结构化检查点字段（与 chain-contract 步记录 schema 的 `checkpoint.summary` 对齐）。 */
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

const LIST_KEYS = [
  'constraints',
  'decisions',
  'findings',
  'files',
  'open_questions',
  'next_steps',
  'errors_to_avoid',
  'user_preferences',
] as const

/** 结构化检查点判定：排除段标记 / verify 报告等内部标记。 */
export function isStructuredCheckpoint(summary: unknown): summary is Rec {
  if (!isRecord(summary)) return false
  if (summary['kind'] === 'segment' || summary['kind'] === 'verify') return false
  return STRUCTURED_KEYS.some((key) => summary[key] !== undefined)
}

/** 本回合最后一条结构化 `checkpoint` 步记录（无则 null）。 */
export function latestCheckpoint(bag: Rec, turnId: string | null): Rec | null {
  let found: Rec | null = null
  for (const step of turnSteps(bag, turnId)) {
    if (!isRecord(step)) continue
    if (step['type'] !== 'checkpoint') continue
    if (!isStructuredCheckpoint(step['summary'])) continue
    found = step
  }
  return found
}

/** 检查点结构化摘要 → 确定文本（与 context-window 的渲染同口径）。 */
export function renderCheckpointText(summary: Rec): string {
  const lines: string[] = []
  const goal = typeof summary['goal'] === 'string' ? (summary['goal'] as string) : ''
  if (goal.length > 0) lines.push(`目标：${goal}`)
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

/** 子代理任务文本：节点 `task` 输入 > `bag.task` > `bag.input`（均支持字符串或 `{content}`）。 */
export function subagentTaskText(inputs: Rec, bag: Rec): string | null {
  for (const value of [inputs['task'], bag['task'], bag['input']]) {
    const text = textOf(value)
    if (text !== null) return text
  }
  return null
}

function textOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (isRecord(value)) {
    const content = value['content']
    if (typeof content === 'string' && content.length > 0) return content
  }
  return null
}

function normalizeResult(value: Rec): Rec {
  const out: Rec = {}
  if (typeof value['goal'] === 'string') out['goal'] = value['goal']
  for (const key of LIST_KEYS) {
    const list = value[key]
    if (Array.isArray(list) && list.length > 0) out[key] = list as Json
  }
  return out
}

/** 从正文解析结构化结果：整段 JSON 或首尾花括号切片；解析失败返回 null。 */
function parseResultJson(text: string): Rec | null {
  const trimmed = stripFence(text.trim())
  if (trimmed.length === 0) return null
  const parsed = tryJson(trimmed) ?? tryJson(sliceBraces(trimmed))
  return isRecord(parsed) ? parsed : null
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return match !== null ? (match[1] as string) : text
}

function sliceBraces(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

function tryJson(text: string | null): Json | null {
  if (text === null || text.length === 0) return null
  try {
    return JSON.parse(text) as Json
  } catch {
    return null
  }
}

/**
 * 子代理产出归一为结构化结果：优先产出里的 `result` 对象，其次从正文解析 JSON；
 * 解析失败时把正文作 `goal`。返回带上承接帧，`tool_calls` 置空（子代理不直接调工具）。
 */
export function toSubagentResult(value: Json): Rec {
  const raw = isRecord(value) ? (value as Rec) : {}
  const explicit = isRecord(raw['result']) ? (raw['result'] as Rec) : null
  const text = typeof raw['text'] === 'string' ? (raw['text'] as string) : ''
  const parsed = explicit ?? parseResultJson(text)
  const result = parsed !== null ? normalizeResult(parsed) : (text.length > 0 ? { goal: text } : {})
  const message: Rec = { role: 'assistant', content: renderCheckpointText(result) }
  return { ...raw, message, tool_calls: [], result }
}
