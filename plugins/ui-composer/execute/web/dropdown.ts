// 下拉弹层的键盘状态机（纯函数）：开合 / 初始定位到当前选中项 / ↑↓ 环绕移动。
// 与原生 select 习惯一致：打开时 `activeIndex` = 当前选中项，无选中项退首条。

export interface DropdownState {
  open: boolean
  activeIndex: number
}

export function createDropdownState(): DropdownState {
  return { open: false, activeIndex: -1 }
}

/** 初始活动项：当前选中项在界内用它，否则首条；空列表回 -1。 */
export function activeIndexFor(selectedIndex: unknown, count: unknown): number {
  if (!Number.isInteger(count) || (count as number) <= 0) return -1
  if (
    Number.isInteger(selectedIndex) &&
    (selectedIndex as number) >= 0 &&
    (selectedIndex as number) < (count as number)
  )
    return selectedIndex as number
  return 0
}

export function openDropdown(
  state: DropdownState,
  selectedIndex: unknown,
  count: unknown,
): DropdownState {
  return { open: true, activeIndex: activeIndexFor(selectedIndex, count) }
}

export function closeDropdown(): DropdownState {
  return createDropdownState()
}

/** ↑↓ 环绕移动；空列表回 -1。 */
export function moveActive(state: DropdownState, delta: number, count: unknown): DropdownState {
  if (!Number.isInteger(count) || (count as number) <= 0) return { ...state, activeIndex: -1 }
  const total = count as number
  const current =
    Number.isInteger(state.activeIndex) && state.activeIndex >= 0 ? state.activeIndex : 0
  const next = (((current + delta) % total) + total) % total
  return { ...state, activeIndex: next }
}

export function isActiveIndex(state: DropdownState, index: unknown): boolean {
  return state.open === true && state.activeIndex === index
}

/** 选项元素的稳定 id（供 `aria-activedescendant`）。 */
export function optionId(prefix: string, index: number): string {
  return `${prefix}-option-${index}`
}
