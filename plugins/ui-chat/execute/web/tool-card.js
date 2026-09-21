// 工具卡（纯函数）：只按 part 里的 `render` 描述符画，不认识任何具体工具。
// 两形态 `line` / `card`；三质感 `ghost` / `plain` / `solid`；无 render / 未知 form → markdown 文本降级。

import { safeStringify } from './render-parts.js'

function isRec(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TONES = new Set(['ghost', 'plain', 'solid'])
const FORMS = new Set(['line', 'card'])

function fieldText(source, path) {
  if (!isRec(source)) return ''
  const segments = String(path).split('.')
  let current = source
  for (const segment of segments) {
    if (!isRec(current) && !Array.isArray(current)) return ''
    current = current[segment]
  }
  if (current === null || current === undefined) return ''
  if (typeof current === 'string') return current
  if (typeof current === 'number' || typeof current === 'boolean') return String(current)
  return safeStringify(current)
}

/**
 * `summary` 模板文法（冻结）：裸 `{field}` = args 字段；`{result.field}` = 结果字段。
 * 缺失字段渲染为空串；过长由调用方截断（不换行溢出）。
 */
export function renderSummary(template, args, result) {
  if (typeof template !== 'string' || template.length === 0) return ''
  return template
    .replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, expr) => {
      if (expr.startsWith('result.')) return fieldText(result, expr.slice('result.'.length))
      return fieldText(args, expr)
    })
    .trim()
}

/** 摘要过长截断（不换行溢出）。 */
export function truncateSummary(text, max = 160) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 无描述符 / 未知 form 时的 markdown 文本降级（不空白、不报错）。 */
export function degradeText(part) {
  if (!isRec(part)) return ''
  const result = part.result
  if (typeof result === 'string' && result.length > 0) return result
  if (isRec(result) && typeof result.text === 'string') return result.text
  if (typeof part.text === 'string' && part.text.length > 0) return part.text
  return safeStringify(result ?? part.args ?? null)
}

/** 工具 part → 工具卡视图模型。 */
export function toolCardViewModel(part) {
  const source = isRec(part) ? part : {}
  const render = isRec(source.render) ? source.render : null
  const label = typeof render?.label === 'string' ? render.label : typeof source.tool === 'string' ? source.tool : ''
  if (render === null) {
    return {
      form: 'degraded',
      label,
      tone: 'plain',
      summary: '',
      detail: null,
      live: false,
      text: degradeText(source),
    }
  }
  const form = typeof render.form === 'string' && FORMS.has(render.form) ? render.form : 'degraded'
  if (form === 'degraded') {
    return {
      form: 'degraded',
      label,
      tone: 'plain',
      summary: '',
      detail: null,
      live: false,
      text: degradeText(source),
    }
  }
  const tone = typeof render.tone === 'string' && TONES.has(render.tone) ? render.tone : 'plain'
  return {
    form,
    label,
    tone,
    summary: truncateSummary(renderSummary(render.summary, source.args, source.result)),
    detail: isRec(render.detail) ? render.detail : null,
    live: render.live === true,
    text: '',
  }
}
