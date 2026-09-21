// DOM 构建小工具（只在浏览器侧使用；顶层不触 document，便于 node 下 import 检查）。

/** 创建元素：props 支持 class / text / attrs / on / dataset。 */
export function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag)
  if (typeof props.class === 'string') node.className = props.class
  if (typeof props.text === 'string') node.textContent = props.text
  if (props.attrs !== undefined) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === false || value === null || value === undefined) continue
      if (value === true) node.setAttribute(key, '')
      else node.setAttribute(key, String(value))
    }
  }
  if (props.dataset !== undefined) {
    for (const [key, value] of Object.entries(props.dataset)) {
      if (value !== undefined && value !== null) node.dataset[key] = String(value)
    }
  }
  if (props.on !== undefined) {
    for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler)
  }
  for (const child of children) append(node, child)
  return node
}

/** 追加子节点：字符串转文本节点，null / false 跳过。 */
export function append(parent, child) {
  if (child === null || child === undefined || child === false) return
  if (typeof child === 'string' || typeof child === 'number') {
    parent.appendChild(parent.ownerDocument.createTextNode(String(child)))
    return
  }
  parent.appendChild(child)
}

/** 用图标 sprite 生成 `<svg><use/></svg>`；带 label 时补可及名。 */
export function icon(doc, name, size = 16, label = '') {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (label.length > 0) {
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
  } else {
    svg.setAttribute('aria-hidden', 'true')
  }
  const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `/assets/icons.v1.svg#${name}`)
  svg.appendChild(use)
  return svg
}

/** 图标按钮：命中区 ≥24×24，必须带 aria-label。 */
export function iconButton(doc, name, label, onClick, size = 16) {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'settings-iconbtn'
  button.setAttribute('aria-label', label)
  button.title = label
  button.appendChild(icon(doc, name, size, label))
  if (typeof onClick === 'function') button.addEventListener('click', onClick)
  return button
}

/** 图标 + 文字按钮：图标仅装饰（aria-hidden），可及名由文字承担。 */
export function labeledButton(doc, iconName, label, onClick, options = {}) {
  const button = textButton(doc, label, onClick, options)
  button.classList.add('settings-labeled-btn')
  button.insertBefore(icon(doc, iconName, 16), button.firstChild)
  return button
}

/** 文字按钮：命中区含横向 padding。 */
export function textButton(doc, label, onClick, options = {}) {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = options.class ?? 'settings-btn'
  if (options.tone !== undefined) button.dataset.tone = options.tone
  button.textContent = label
  if (options.disabled === true) button.disabled = true
  if (typeof onClick === 'function') button.addEventListener('click', onClick)
  return button
}

export function clear(node) {
  if (node !== null) node.replaceChildren()
}
