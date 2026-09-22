// 下拉弹层的键盘状态机（纯函数）：开合 / 初始定位到当前选中项 / ↑↓ 环绕移动。
// 与原生 select 习惯一致：打开时 `activeIndex` = 当前选中项，无选中项退首条。

export function createDropdownState() {
  return { open: false, activeIndex: -1 }
}

/** 初始活动项：当前选中项在界内用它，否则首条；空列表回 -1。 */
export function activeIndexFor(selectedIndex, count) {
  if (!Number.isInteger(count) || count <= 0) return -1
  if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < count)
    return selectedIndex
  return 0
}

export function openDropdown(state, selectedIndex, count) {
  return { open: true, activeIndex: activeIndexFor(selectedIndex, count) }
}

export function closeDropdown() {
  return createDropdownState()
}

/** ↑↓ 环绕移动；空列表回 -1。 */
export function moveActive(state, delta, count) {
  if (!Number.isInteger(count) || count <= 0) return { ...state, activeIndex: -1 }
  const current =
    Number.isInteger(state.activeIndex) && state.activeIndex >= 0 ? state.activeIndex : 0
  const next = (((current + delta) % count) + count) % count
  return { ...state, activeIndex: next }
}

export function isActiveIndex(state, index) {
  return state.open === true && state.activeIndex === index
}

/** 选项元素的稳定 id（供 `aria-activedescendant`）。 */
export function optionId(prefix, index) {
  return `${prefix}-option-${index}`
}
