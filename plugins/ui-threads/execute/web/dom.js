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

/** 清空子节点。 */
export function clear(node) {
  if (node !== null && node !== undefined) node.replaceChildren()
}
