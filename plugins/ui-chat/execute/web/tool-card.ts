// 工具卡（纯函数）：只按 part 里的 `render` 描述符画，不认识任何具体工具。
// 两形态 `line` / `card`；三质感 `ghost` / `plain` / `solid`；无 render / 未知 form → markdown 文本降级。

import { safeStringify } from './render-parts.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TONES = new Set(['ghost', 'plain', 'solid'])
const FORMS = new Set(['line', 'card'])

/** 工具名 → 图标名（壳 icons 精灵表内的 id）；未登记走通用图标，工具可经 `render.icon` 覆盖。 */
const TOOL_ICONS: { [key: string]: string } = {
  read: 'folder-open',
  glob: 'folder',
  grep: 'search',
  edit: 'pencil-line',
  stat: 'info',
  write: 'upload',
  shell: 'monitor',
  exec: 'monitor',
  browser: 'eye',
  fetch: 'eye',
  question: 'info',
  plugin: 'puzzle',
  orchestration: 'git-branch',
}

/** 工具卡图标名：显式 `render.icon` 优先，否则按工具名登记，再否则通用图标。 */
export function toolIcon(name: unknown, explicit: unknown): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const key = typeof name === 'string' ? name : ''
  return TOOL_ICONS[key] ?? 'cpu'
}

function fieldText(source: any, path: string): string {
  if (!isRec(source)) return ''
  const segments = String(path).split('.')
  let current: any = source
  for (const segment of segments) {
    if (!isRec(current) && !Array.isArray(current)) return ''
    current = (current as any)[segment]
  }
  if (current === null || current === undefined) return ''
  if (typeof current === 'string') return current
  if (typeof current === 'number' || typeof current === 'boolean') return String(current)
  return safeStringify(current)
}

/**
 * `summary` 模板文法：裸 `{field}` = args 字段；`{result.field}` = 结果字段；
 * `{? ... }` = 可选段（段内任一字段解析为空则整段不输出，避免缺省参数留下悬空分隔符）。
 * 缺失字段渲染为空串；过长由调用方截断（不换行溢出）。
 */
export function renderSummary(template: unknown, args: any, result: any): string {
  if (typeof template !== 'string' || template.length === 0) return ''
  return expandTemplate(template, args, result).text.trim()
}

const SUMMARY_FIELD = /^[a-zA-Z0-9_.]+$/

/** 展开模板；返回文本与「是否含解析为空的字段」标记（供外层可选段判定）。 */
function expandTemplate(
  template: string,
  args: any,
  result: any,
): { text: string; missing: boolean } {
  let text = ''
  let missing = false
  let index = 0
  while (index < template.length) {
    const char = template[index]
    if (char === '{' && template[index + 1] === '?') {
      const close = matchGroup(template, index)
      if (close === -1) {
        text += char
        index += 1
        continue
      }
      const inner = expandTemplate(template.slice(index + 2, close), args, result)
      if (!inner.missing) text += inner.text
      index = close + 1
      continue
    }
    if (char === '{') {
      const close = template.indexOf('}', index)
      const expr = close === -1 ? '' : template.slice(index + 1, close)
      if (close !== -1 && SUMMARY_FIELD.test(expr)) {
        const value = expr.startsWith('result.')
          ? fieldText(result, expr.slice('result.'.length))
          : fieldText(args, expr)
        if (value.length === 0) missing = true
        text += value
        index = close + 1
        continue
      }
      text += char
      index += 1
      continue
    }
    text += char
    index += 1
  }
  return { text, missing }
}

/** 找 `{?` 的配对 `}`：按花括号深度配对，段内可含 `{field}`。 */
function matchGroup(template: string, start: number): number {
  let depth = 1
  for (let index = start + 2; index < template.length; index += 1) {
    if (template[index] === '{') depth += 1
    else if (template[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** 摘要过长截断（不换行溢出）。 */
export function truncateSummary(text: unknown, max = 160): string {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 无描述符 / 未知 form 时的 markdown 文本降级（不空白、不报错）。 */
export function degradeText(part: any): string {
  if (!isRec(part)) return ''
  const result = part.result
  if (typeof result === 'string' && result.length > 0) return result
  if (isRec(result) && typeof result.text === 'string') return result.text
  if (typeof part.text === 'string' && part.text.length > 0) return part.text
  return safeStringify(result ?? part.args ?? null)
}

/**
 * detail 描述符 + 工具结果合并：`kind` 等描述符字段优先（来自 render.detail），
 * 数据字段来自结果本体（如 glob 的 `paths`、shell 的 `stdout`、edit 的 `patch`）。
 * 结果是数组（如 glob 直接回 `paths`）时挂到 `items`，否则展开区会「有结果却渲染空白」。
 */
function mergeDetail(descriptor: any, result: any): any {
  if (!isRec(descriptor)) return null
  if (Array.isArray(result)) return { ...descriptor, items: result }
  if (isRec(result)) return { ...result, ...descriptor }
  return { ...descriptor }
}

/** 失败工具卡的展开内容：错误码 + 人话（无 result 数据可合并）。 */
function errorDetail(result: any): any {
  if (isRec(result)) {
    const code = typeof result.code === 'string' ? result.code : ''
    const message = typeof result.message === 'string' ? result.message : ''
    const text = [code, message].filter((piece) => piece.length > 0).join(': ')
    if (text.length > 0) return { kind: 'text', text }
  }
  return { kind: 'text', text: typeof result === 'string' ? result : '' }
}

/** 无 render 时的通用细节推断：终端合并流 / 路径列表 / 文本 / JSON（不把结构化结果原样丢成正文）。 */
function genericDetail(result: any): any {
  if (Array.isArray(result)) return { kind: 'list', items: result }
  if (isRec(result)) {
    if (Array.isArray(result.combined)) {
      const text = result.combined
        .filter((chunk: any) => isRec(chunk) && typeof chunk.text === 'string')
        .map((chunk: any) => chunk.text as string)
        .join('')
      return { kind: 'terminal', stdout: text }
    }
    if (Array.isArray(result.paths)) return { kind: 'paths', items: result.paths }
    if (typeof result.text === 'string') return { kind: 'text', text: result.text }
    if (typeof result.content === 'string') return { kind: 'text', text: result.content }
    return { kind: 'json', text: safeStringify(result) }
  }
  if (typeof result === 'string') return result.length > 0 ? { kind: 'text', text: result } : null
  return null
}

/** 有结果但缺 render 时的通用工具卡：不再降级成 raw JSON 正文，按结果形态给终端 / 文本 / JSON 细节。 */
function genericToolCard(source: any): any {
  const status = source.status === 'ok' || source.status === 'error' ? source.status : null
  const failed = status === 'error'
  return {
    form: 'card',
    label: typeof source.tool === 'string' ? source.tool : '',
    tone: 'plain',
    summary: '',
    detail: failed ? errorDetail(source.result) : genericDetail(source.result),
    status,
    icon: toolIcon(source.tool, undefined),
    live: false,
    text: '',
  }
}

/** 工具 part → 工具卡视图模型。 */
export function toolCardViewModel(part: any): any {
  const source = isRec(part) ? part : {}
  const render = isRec(source.render) ? source.render : null
  const label = typeof render?.label === 'string' ? render.label : typeof source.tool === 'string' ? source.tool : ''
  const status = source.status === 'ok' || source.status === 'error' ? source.status : null
  const icon = toolIcon(source.tool, render?.icon)
  // 有结果却缺 render：通用卡（不把结果 JSON 泄成正文）；无结果才退回 markdown 文本降级。
  const hasResult = source.result !== undefined && source.result !== null
  if (render === null) {
    if (hasResult) return genericToolCard(source)
    return {
      form: 'degraded',
      label,
      tone: 'plain',
      summary: '',
      detail: null,
      status,
      icon,
      live: false,
      text: degradeText(source),
    }
  }
  const form = typeof render.form === 'string' && FORMS.has(render.form) ? render.form : 'degraded'
  if (form === 'degraded') {
    if (hasResult) return genericToolCard(source)
    return {
      form: 'degraded',
      label,
      tone: 'plain',
      summary: '',
      detail: null,
      status,
      icon,
      live: false,
      text: degradeText(source),
    }
  }
  const tone = typeof render.tone === 'string' && TONES.has(render.tone) ? render.tone : 'plain'
  const failed = status === 'error'
  return {
    form,
    label,
    tone,
    summary: truncateSummary(renderSummary(render.summary, source.args, source.result)),
    detail: failed ? errorDetail(source.result) : mergeDetail(render.detail, source.result),
    status,
    icon,
    args: source.args ?? null,
    live: render.live === true,
    text: '',
  }
}
