// 设置视图共用 DOM 片段（只在浏览器侧使用）：字段 / 行 / 分组 / 空态 / 加载 / 错误条。
// 可及性：字段与行标签对可标控件用 `<label for>`，复合控件用 `aria-label`。

import { el, icon, textButton } from './dom.js'

let idSeq = 0

/** 生成唯一控件 id（标签关联用）。 */
export function nextId(prefix) {
  idSeq += 1
  return `settings-${prefix}-${idSeq}`
}

function isLabelable(node) {
  if (node === null || typeof node !== 'object') return false
  const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
  return tag === 'input' || tag === 'select' || tag === 'textarea'
}

/** 表单字段：label + 控件；可标控件用 `for`，复合控件退化为分组 `aria-label`。`required` 只加视觉标记与 `aria-required`。
 *  `options.frame(control)` 可给控件包一层壳（如自定义下拉箭头），标签仍关联内层控件。 */
export function field(ctx, label, control, options = {}) {
  let labelNode
  if (isLabelable(control)) {
    if (typeof control.id !== 'string' || control.id.length === 0) control.id = nextId('field')
    labelNode = el(ctx.doc, 'label', { class: 'settings-field-label', text: label, attrs: { for: control.id } })
    if (options.required === true) control.setAttribute('aria-required', 'true')
  } else {
    labelNode = el(ctx.doc, 'span', { class: 'settings-field-label', text: label })
    if (control !== null && typeof control.setAttribute === 'function') control.setAttribute('aria-label', label)
  }
  if (options.required === true) {
    labelNode.appendChild(el(ctx.doc, 'span', { class: 'settings-required-mark', text: '*', attrs: { 'aria-hidden': 'true' } }))
  }
  const controlNode = typeof options.frame === 'function' ? options.frame(control) : control
  return el(ctx.doc, 'div', { class: 'settings-field' }, [labelNode, controlNode])
}

/** 行式只读 / 控件行：label 左、控件右；可标控件自动建立标签关联。 */
export function row(ctx, label, valueNode, options = {}) {
  let labelNode
  if (isLabelable(valueNode)) {
    if (typeof valueNode.id !== 'string' || valueNode.id.length === 0) valueNode.id = nextId('row')
    labelNode = el(ctx.doc, 'label', { class: 'settings-row-label', text: label, attrs: { for: valueNode.id } })
  } else {
    labelNode = el(ctx.doc, 'span', { class: 'settings-row-label', text: label })
  }
  const node = el(ctx.doc, 'div', { class: 'settings-row' }, [
    labelNode,
    el(ctx.doc, 'span', { class: 'settings-row-value' }, [valueNode]),
  ])
  if (typeof options.savedKey === 'string') node.dataset.savedKey = options.savedKey
  return node
}

/** 分组：可选分组名 + 子节点（行式无分隔，无组卡片）。 */
export function section(ctx, nameKey, children) {
  const node = el(ctx.doc, 'div', { class: 'settings-section' })
  if (nameKey !== null) node.appendChild(el(ctx.doc, 'div', { class: 'settings-group-name', text: ctx.text(nameKey) }))
  for (const child of children) node.appendChild(child)
  return node
}

/** 行内错误条：danger 竖线 + 人话 + 可选 [重试]（不弹窗）。 */
export function errorBar(ctx, error, onRetry) {
  const bar = el(ctx.doc, 'div', { class: 'settings-error', attrs: { role: 'alert' } })
  bar.appendChild(icon(ctx.doc, 'alert-circle', 16))
  bar.appendChild(el(ctx.doc, 'span', { text: ctx.text(error.code) }))
  if (typeof onRetry === 'function') bar.appendChild(textButton(ctx.doc, ctx.text('settings_retry'), onRetry))
  return bar
}

/** 统一空态：图标 + 说明 + 可选提示。 */
export function emptyState(ctx, key, hintKey) {
  return el(ctx.doc, 'div', { class: 'settings-empty' }, [
    icon(ctx.doc, 'info', 20),
    el(ctx.doc, 'div', { text: ctx.text(key) }),
    hintKey !== undefined ? el(ctx.doc, 'div', { class: 'settings-empty-hint', text: ctx.text(hintKey) }) : null,
  ])
}

/** 只读页块级加载：居中呼吸条；>8s 追加「仍在读取…」。 */
export function blockLoading(ctx, note) {
  return el(ctx.doc, 'div', { class: 'settings-block-loading' }, [
    el(ctx.doc, 'div', { class: 'settings-breathe' }),
    note ? el(ctx.doc, 'div', { text: ctx.text('settings_loading_more') }) : null,
  ])
}

/** 依赖未就绪降级条（不因缺身份崩溃）。 */
export function dependencyMissing(ctx) {
  return el(ctx.doc, 'div', { class: 'settings-warning-bar' }, [
    icon(ctx.doc, 'alert-triangle', 16),
    el(ctx.doc, 'span', {
      text: `${ctx.text('settings_dependency_missing')} · ${ctx.text('settings_dependency_missing_hint')}`,
    }),
  ])
}
