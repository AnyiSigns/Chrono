// compress 测试用假提供方（summarize / semantic / dedup）：仅在测试进程内仿真反向 port.call 应答，
// 不 import 任何兄弟插件源码（插件间不得直连）；这些原语的真实行为由其各自插件的测试覆盖。
// 这里只保证「消费方编排 + 端口契约形状」可测：摘要形状 / 派生 / 合并、语义回包、精确文本去重。

// ── 摘要形状（与 summarize 提供方同口径的最小实现） ─────────────────────────

const SUMMARY_LIST_FIELDS = ['decisions', 'facts', 'open_questions', 'files', 'next_steps']

export function emptySummary() {
  return { goal: '', decisions: [], facts: [], open_questions: [], files: [], next_steps: [] }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function uniqueStrings(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const text = normalizeText(item)
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function truncate(text, max) {
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('') : text
}

function sentencesOf(text) {
  return text
    .split(/(?<=[。！？!?])\s*|(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeText(sentence))
    .filter((sentence) => sentence.length > 0)
}

function deriveSentences(sessionSlice, limit, targetLength) {
  if (!Array.isArray(sessionSlice)) return []
  const contents = []
  for (const item of sessionSlice) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof item.content === 'string' &&
      item.content.length > 0
    ) {
      contents.push(item.content)
    }
  }
  return uniqueStrings(contents.flatMap(sentencesOf))
    .map((sentence) => truncate(sentence, targetLength))
    .filter((sentence) => sentence.length > 0)
    .slice(0, limit)
}

function lenientList(value) {
  return Array.isArray(value) ? uniqueStrings(value.filter((item) => typeof item === 'string')) : []
}

export function parseSummary(value) {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const summary = emptySummary()
  summary.goal = normalizeText(record.goal)
  for (const field of SUMMARY_LIST_FIELDS) summary[field] = lenientList(record[field])
  return summary
}

function truncateSummary(summary, max) {
  const clamped = emptySummary()
  clamped.goal = truncate(summary.goal, max)
  for (const field of SUMMARY_LIST_FIELDS)
    clamped[field] = summary[field].map((item) => truncate(item, max))
  return clamped
}

function summaryFromArgs(args, targetLength, extractItems) {
  const summary = emptySummary()
  summary.goal = truncate(normalizeText(args.goal), targetLength)
  for (const field of SUMMARY_LIST_FIELDS) {
    const provided = uniqueStrings(Array.isArray(args[field]) ? args[field] : []).map((item) =>
      truncate(item, targetLength),
    )
    summary[field] = provided
  }
  if (summary.goal.length === 0)
    summary.goal = deriveSentences(args.session_slice, 1, targetLength)[0] ?? ''
  if (summary.facts.length === 0)
    summary.facts = deriveSentences(args.session_slice, extractItems, targetLength)
  return summary
}

function summaryFromSource(args, targetLength, extractItems) {
  if (typeof args.summary === 'object' && args.summary !== null && !Array.isArray(args.summary)) {
    return truncateSummary(parseSummary(args.summary), targetLength)
  }
  return summaryFromArgs(args, targetLength, extractItems)
}

function summaryToJson(summary) {
  return {
    goal: summary.goal,
    decisions: summary.decisions,
    facts: summary.facts,
    open_questions: summary.open_questions,
    files: summary.files,
    next_steps: summary.next_steps,
  }
}

function summaryToL2Json(summary) {
  return {
    goal: summary.goal,
    decisions: summary.decisions,
    facts: summary.facts,
    open_questions: summary.open_questions,
    files: summary.files,
  }
}

export function mergeSummaryLists(existing, incoming, outcomes) {
  const summary = emptySummary()
  summary.goal = incoming.goal.length > 0 ? incoming.goal : existing.goal
  let path = 'text'
  for (const field of SUMMARY_LIST_FIELDS) {
    const outcome = outcomes !== null && typeof outcomes === 'object' ? outcomes[field] : undefined
    const accepted =
      outcome !== null && typeof outcome === 'object' && Array.isArray(outcome.accepted)
        ? outcome.accepted.filter((item) => typeof item === 'string')
        : []
    if (outcome !== null && typeof outcome === 'object' && outcome.dedup === 'vector')
      path = 'vector'
    summary[field] = [...existing[field], ...accepted]
  }
  return { summary, dedup: path }
}

// ── 端口应答 ───────────────────────────────────────────────────────────────

/** summarize.* 端口应答：按方法回摘要形状。 */
export function summarizeResponse(method, args) {
  switch (method) {
    case 'derive':
      return { summary: summaryFromSource(args.args ?? {}, args.target_length, args.extract_items) }
    case 'parse':
      return { summary: parseSummary(args.record) }
    case 'current':
      return { summary: truncateSummary(parseSummary(args.record), args.target_length) }
    case 'sentences':
      return { sentences: deriveSentences(args.session_slice, args.limit, args.target_length) }
    case 'merge':
      return mergeSummaryLists(
        parseSummary(args.existing),
        parseSummary(args.incoming),
        args.outcomes,
      )
    case 'to_l1':
      return { record: summaryToJson(parseSummary(args.summary)) }
    case 'to_l2':
      return { record: summaryToL2Json(parseSummary(args.summary)) }
    default:
      return undefined
  }
}

/** semantic.summarize 默认应答：确定性的同结构记录。 */
export function semanticResponse() {
  return { summary: { goal: 'semantic-goal', facts: ['sf1', 'sf2'] } }
}

/** dedup.dedup 默认应答：精确文本去重（向量路径由 dedup 插件测试覆盖）。 */
export function dedupResponse(args) {
  const referenceSet = new Set(
    (Array.isArray(args.reference) ? args.reference : []).map(normalizeText),
  )
  const accepted = uniqueStrings(args.incoming ?? []).filter((text) => !referenceSet.has(text))
  return { accepted, dedup: 'text' }
}

/** 默认端口应答（非 short-memory）：命中摘要 / 语义 / 去重，否则 not_ready。 */
export function defaultPortResponse(port, method, args) {
  if (port === 'summarize') {
    const value = summarizeResponse(method, args)
    return value === undefined
      ? { error: 'unknown_method', message: `unknown ${method}` }
      : { value }
  }
  if (port === 'semantic') {
    if (method !== 'summarize') return { error: 'unknown_method', message: `unknown ${method}` }
    return { value: semanticResponse(args) }
  }
  if (port === 'dedup') {
    if (method !== 'dedup') return { error: 'unknown_method', message: `unknown ${method}` }
    return { value: dedupResponse(args) }
  }
  return { error: 'not_ready', message: 'no resolver' }
}
