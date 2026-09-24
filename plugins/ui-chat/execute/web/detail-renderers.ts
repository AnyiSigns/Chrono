// 工具卡展开态渲染器（纯函数视图模型）：detail.kind 全集归一。
// text / code / diff / matches / paths / list / table / json / file / image / terminal / question；
// 未知 kind → 文本降级（不空白、不报错）。DOM 构建在 entry.tsx，本模块只出可测数据。

import { assetSource, safeStringify } from './render-parts.ts'
import { formatText, UI_TEXT } from './messages.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拆分文本为行（统一换行）。 */
export function splitLines(text: unknown): string[] {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (source.length === 0) return []
  return source.split('\n')
}

const DIFF_CELL_CAP = 250000

/**
 * 逐行 diff（LCS）：产出 ctx / del / add 行，相邻 del+add 配成 mod（修改黄），
 * 连续 ctx 超长折叠成 hunk。规模超上限时退化为「全删 + 全增」（不 O(n*m) 爆炸）。
 */
export function computeDiff(before: unknown, after: unknown, context = 3): { rows: any[]; truncated: boolean } {
  const a = splitLines(before)
  const b = splitLines(after)
  let ops: any[]
  if (a.length * b.length > DIFF_CELL_CAP) {
    ops = [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ]
  } else {
    ops = lcsOps(a, b)
  }
  const numbered: any[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    if (op.type === 'ctx') {
      numbered.push({ type: 'ctx', oldLine, newLine, text: op.text, prefix: '  ' })
      oldLine += 1
      newLine += 1
    } else if (op.type === 'del') {
      numbered.push({ type: 'del', oldLine, text: op.text, prefix: '- ' })
      oldLine += 1
    } else {
      numbered.push({ type: 'add', newLine, text: op.text, prefix: '+ ' })
      newLine += 1
    }
  }
  const paired: any[] = []
  for (let i = 0; i < numbered.length; i++) {
    const row = numbered[i]
    const next = numbered[i + 1]
    if (row.type === 'del' && next !== undefined && next.type === 'add') {
      paired.push({
        type: 'mod',
        oldLine: row.oldLine,
        newLine: next.newLine,
        before: row.text,
        after: next.text,
        text: formatText('chat_diff_mod', { before: row.text, after: next.text }),
      })
      i += 1
      continue
    }
    paired.push(row)
  }
  return { rows: collapseContext(paired, context), truncated: a.length * b.length > DIFF_CELL_CAP }
}

function lcsOps(a: string[], b: string[]): any[] {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: any[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] })
    j += 1
  }
  return ops
}

function collapseContext(rows: any[], context: number): any[] {
  const out: any[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== 'ctx') {
      out.push(rows[i])
      i += 1
      continue
    }
    let end = i
    while (end < rows.length && rows[end].type === 'ctx') end += 1
    const run = rows.slice(i, end)
    if (run.length <= context * 2 + 1) {
      out.push(...run)
    } else {
      const count = run.length - context * 2
      out.push(...run.slice(0, context))
      out.push({ type: 'hunk', count, text: formatText('chat_diff_collapsed', { count }) })
      out.push(...run.slice(run.length - context))
    }
    i = end
  }
  return out
}

/** 解析 unified diff 文本（`@@` / `+` / `-` / 空格）。 */
export function parsePatch(patch: unknown, context = 3): { rows: any[]; truncated: boolean } {
  void context
  const rows: any[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of splitLines(patch)) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (match !== null) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      rows.push({ type: 'hunk', text: line })
      continue
    }
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('+')) {
      rows.push({ type: 'add', newLine, text: line.slice(1), prefix: '+ ' })
      newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ type: 'del', oldLine, text: line.slice(1), prefix: '- ' })
      oldLine += 1
      continue
    }
    if (line.startsWith(' ') || line.length === 0) {
      rows.push({ type: 'ctx', oldLine, newLine, text: line.slice(1), prefix: '  ' })
      oldLine += 1
      newLine += 1
    }
  }
  return { rows, truncated: false }
}

function normalizeMatches(value: unknown): any[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return { path: '', line: 0, text: item }
    if (!isRec(item)) return { path: '', line: 0, text: String(item) }
    const line = item.line ?? item.lineno ?? item.line_number ?? 0
    return {
      path: typeof item.path === 'string' ? item.path : typeof item.file === 'string' ? item.file : '',
      line: typeof line === 'number' ? line : 0,
      text: typeof item.text === 'string' ? item.text : typeof item.match === 'string' ? item.match : typeof item.snippet === 'string' ? item.snippet : '',
    }
  })
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    typeof item === 'string' ? item : isRec(item) && typeof item.path === 'string' ? item.path : safeStringify(item),
  )
}

function normalizeQuestion(question: unknown): any {
  if (!isRec(question)) {
    return { id: '', header: '', question: String(question ?? ''), options: [], multiple: false, custom: true }
  }
  const options = Array.isArray(question.options)
    ? question.options.map((option: any) =>
        isRec(option)
          ? { label: typeof option.label === 'string' ? option.label : String(option.value ?? ''), description: typeof option.description === 'string' ? option.description : '' }
          : { label: String(option), description: '' },
      )
    : []
  return {
    id: typeof question.id === 'string' ? question.id : '',
    header: typeof question.header === 'string' ? question.header : '',
    question: typeof question.question === 'string' ? question.question : typeof question.text === 'string' ? question.text : '',
    options,
    multiple: question.multiple === true,
    custom: question.custom !== false,
  }
}

function normalizeAnswers(value: unknown): any[] {
  if (Array.isArray(value)) {
    return value.filter(isRec).map((answer) => ({
      questionId:
        typeof answer.question_id === 'string'
          ? answer.question_id
          : typeof answer.questionId === 'string'
            ? answer.questionId
            : typeof answer.id === 'string'
              ? answer.id
              : '',
      selected: Array.isArray(answer.selected) ? answer.selected.map(String) : [],
      custom: typeof answer.custom === 'string' ? answer.custom : null,
    }))
  }
  if (isRec(value)) {
    return Object.entries(value).map(([questionId, selected]) => ({
      questionId,
      selected: Array.isArray(selected) ? selected.map(String) : [String(selected)],
      custom: null,
    }))
  }
  return []
}

function answerTextOf(answer: any): string {
  if (!isRec(answer)) return ''
  const pieces: string[] = Array.isArray(answer.selected) ? answer.selected.map(String) : []
  if (typeof answer.custom === 'string' && answer.custom.length > 0) pieces.push(answer.custom)
  return pieces.join(UI_TEXT.chat_answer_sep)
}

/** 取某问题的已答文本（选中 + 自定义，顿号分隔）；兼容原始 `question_id` 与本地 `questionId` 形态。 */
export function questionAnswerText(answers: unknown, questionId: string): string {
  const list = normalizeAnswers(answers)
  return answerTextOf(list.find((answer) => answer.questionId === questionId))
}

function questionViewModel(detail: any): any {
  const answers = normalizeAnswers(detail.answers)
  const questions = (Array.isArray(detail.questions) ? detail.questions : []).map(normalizeQuestion).map((question: any) => ({
    ...question,
    answerText: answerTextOf(answers.find((answer) => answer.questionId === question.id)),
  }))
  const expired = detail.expired === true || detail.status === 'expired'
  const itemId = detail.id ?? detail.item_id ?? detail.itemId ?? null
  return {
    kind: 'question',
    interactive: detail.interactive !== false,
    expired,
    answered: answers.length > 0 || detail.answered === true,
    itemId: typeof itemId === 'string' ? itemId : null,
    thread: typeof detail.thread === 'string' ? detail.thread : null,
    questions,
    answers,
  }
}

/** detail 描述符 → 渲染器视图模型；null / undefined 给中性空文本（不渲染字面 "null"）。 */
export function detailViewModel(detail: unknown): any {
  if (detail === null || detail === undefined) return { kind: 'text', text: '' }
  if (!isRec(detail)) return { kind: 'text', text: safeStringify(detail) }
  const kind = typeof detail.kind === 'string' ? detail.kind : 'text'
  switch (kind) {
    case 'text':
      return { kind: 'text', text: typeof detail.text === 'string' ? detail.text : '' }
    case 'code':
      return {
        kind: 'code',
        text: typeof detail.text === 'string' ? detail.text : typeof detail.code === 'string' ? detail.code : '',
        language: typeof detail.language === 'string' ? detail.language : '',
      }
    case 'diff': {
      const parsed = typeof detail.patch === 'string' ? parsePatch(detail.patch) : computeDiff(detail.before ?? '', detail.after ?? '')
      return { kind: 'diff', rows: parsed.rows, truncated: parsed.truncated }
    }
    case 'matches':
      return { kind: 'matches', items: normalizeMatches(detail.matches ?? detail.items) }
    case 'paths':
      return { kind: 'paths', items: normalizeStrings(detail.paths ?? detail.items) }
    case 'list':
      return { kind: 'list', items: Array.isArray(detail.items) ? detail.items : [] }
    case 'table': {
      const columns = Array.isArray(detail.columns)
        ? detail.columns.map((column: any) => (isRec(column) ? String(column.title ?? column.key ?? '') : String(column)))
        : []
      const rows = Array.isArray(detail.rows) ? detail.rows.map((row: any) => (Array.isArray(row) ? row.map(cellText) : [])) : []
      return { kind: 'table', columns, rows }
    }
    case 'json':
      return { kind: 'json', text: safeStringify(detail.value ?? detail.json ?? detail) }
    case 'file':
      return {
        kind: 'file',
        name: typeof detail.name === 'string' ? detail.name : UI_TEXT.chat_file,
        source: assetSource(detail),
        text: typeof detail.text === 'string' ? detail.text : null,
      }
    case 'image':
      return { kind: 'image', source: assetSource(detail) }
    case 'terminal': {
      const exitCode =
        typeof detail.exit_code === 'number'
          ? detail.exit_code
          : typeof detail.exitCode === 'number'
            ? detail.exitCode
            : null
      return {
        kind: 'terminal',
        stdout: typeof detail.stdout === 'string' ? detail.stdout : '',
        stderr: typeof detail.stderr === 'string' ? detail.stderr : '',
        exitCode,
        exitText: exitCode !== null ? formatText('chat_exit_code', { code: exitCode }) : '',
        running: detail.running === true,
      }
    }
    case 'question':
      return questionViewModel(detail)
    default:
      return { kind: 'text', text: safeStringify(detail) }
  }
}

function cellText(cell: any): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
  return safeStringify(cell)
}
