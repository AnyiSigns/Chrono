// 结构化摘要（L1 / L2 共用形状）与确定性派生：
// - 摘要字段：goal / decisions / facts / open_questions / files / next_steps（L2 去掉 next_steps）。
// - algorithmic 模式：结构化字段优先，缺失字段由会话切片按句切分派生（零 token、完全确定）。
// - 合并：新条目与现有条目去重（向量 / 文本，见 dedup.ts）后追加，保留现有顺序与内容。

import { asStringList, isRecord, normalizeText, uniqueStrings } from './plan.ts'
import type { Json, Rec } from './types.ts'
import type { DedupResult } from './dedup.ts'

export interface Summary {
  goal: string
  decisions: string[]
  facts: string[]
  open_questions: string[]
  files: string[]
  next_steps: string[]
}

/** 可合并的列表字段（L1 全量；L2 写出时去掉 next_steps）。 */
export const SUMMARY_LIST_FIELDS = [
  'decisions',
  'facts',
  'open_questions',
  'files',
  'next_steps',
] as const

/** 去重函数签名（绑定后端与阈值后注入）。 */
export type DedupFn = (incoming: string[], reference: string[]) => Promise<DedupResult>

const SENTENCE_SPLIT = /(?<=[。！？!?])\s*|(?<=[.!?])\s+|\n+/

export function emptySummary(): Summary {
  return { goal: '', decisions: [], facts: [], open_questions: [], files: [], next_steps: [] }
}

/** 截断到 max 个 Unicode 码点；按码点切分，避免劈开代理对（emoji 等星平面字符）。 */
export function truncate(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('') : text
}

/** 按句切分（中英标点 + 换行）；空片丢弃。 */
export function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((sentence) => normalizeText(sentence))
    .filter((sentence) => sentence.length > 0)
}

/** 从会话切片派生句子：逐条取 content、按句切分、去重、截断，取前 limit 条。 */
export function deriveSentences(sessionSlice: Json | undefined, limit: number, targetLength: number): string[] {
  if (!Array.isArray(sessionSlice)) return []
  const contents: string[] = []
  for (const item of sessionSlice) {
    if (!isRecord(item)) continue
    const content = item['content']
    if (typeof content === 'string' && content.length > 0) contents.push(content)
  }
  const sentences = uniqueStrings(contents.flatMap((content) => sentencesOf(content)))
  return sentences.map((sentence) => truncate(sentence, targetLength)).filter((sentence) => sentence.length > 0).slice(0, limit)
}

/** 宽松取字符串数组：只保留字符串项，不抛错（用于模型 / 摘要记录）。 */
function lenientList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'))
}

/** 从摘要记录解析 Summary（缺失 / 非字符串项忽略）。 */
export function parseSummary(value: Json | undefined): Summary {
  if (!isRecord(value)) return emptySummary()
  const summary = emptySummary()
  summary.goal = normalizeText(value['goal'])
  for (const field of SUMMARY_LIST_FIELDS) summary[field] = lenientList(value[field])
  return summary
}

/** 把目标长度一致地作用到摘要全字段（goal 与各列表项），与派生 / 结构化字段同口径。 */
export function truncateSummary(summary: Summary, max: number): Summary {
  const clamped = emptySummary()
  clamped.goal = truncate(summary.goal, max)
  for (const field of SUMMARY_LIST_FIELDS) clamped[field] = summary[field].map((item) => truncate(item, max))
  return clamped
}

/** algorithmic：结构化字段优先，缺失字段由切片按句派生。 */
export function summaryFromArgs(args: Rec, targetLength: number, extractItems: number): Summary {
  const summary = emptySummary()
  const slice = args['session_slice']
  summary.goal = truncate(normalizeText(args['goal']), targetLength)
  for (const field of SUMMARY_LIST_FIELDS) {
    const provided = uniqueStrings(asStringList(args[field], field)).map((item) => truncate(item, targetLength))
    summary[field] = provided
  }
  if (summary.goal.length === 0) {
    const first = deriveSentences(slice, 1, targetLength)
    summary.goal = first[0] ?? ''
  }
  if (summary.facts.length === 0) {
    summary.facts = deriveSentences(slice, extractItems, targetLength)
  }
  return summary
}

/** 摘要来源：优先 args.summary（压缩产物），否则由扁平字段 / 切片派生。 */
export function summaryFromSource(args: Rec, targetLength: number, extractItems: number): Summary {
  if (isRecord(args['summary'])) return truncateSummary(parseSummary(args['summary']), targetLength)
  return summaryFromArgs(args, targetLength, extractItems)
}

/** L1 写出形状（六个字段）。 */
export function summaryToJson(summary: Summary): Rec {
  return {
    goal: summary.goal,
    decisions: summary.decisions,
    facts: summary.facts,
    open_questions: summary.open_questions,
    files: summary.files,
    next_steps: summary.next_steps,
  }
}

/** L2 写出形状（无 next_steps）。 */
export function summaryToL2Json(summary: Summary): Rec {
  return {
    goal: summary.goal,
    decisions: summary.decisions,
    facts: summary.facts,
    open_questions: summary.open_questions,
    files: summary.files,
  }
}

/** 合并：新列表与现有列表去重后追加；goal 新值优先。 */
export async function mergeSummaryLists(
  existing: Summary,
  incoming: Summary,
  dedup: DedupFn,
): Promise<{ summary: Summary; dedup: 'vector' | 'text' }> {
  const summary = emptySummary()
  summary.goal = incoming.goal.length > 0 ? incoming.goal : existing.goal
  let path: 'vector' | 'text' = 'text'
  for (const field of SUMMARY_LIST_FIELDS) {
    const result = await dedup(incoming[field], existing[field])
    if (result.dedup === 'vector') path = 'vector'
    summary[field] = [...existing[field], ...result.accepted]
  }
  return { summary, dedup: path }
}
