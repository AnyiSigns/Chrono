// 侧栏宽度与窄屏分支（纯函数）：展开 / 收缩宽度、拉伸夹取、断点、写回防抖。
// 断点口径：≥1024 展开且可拉伸；768–1023 与 <768 强制收缩 56、不可拉伸（不引入抽屉）。

/** 展开默认宽度。 */
export const WIDTH_EXPANDED = 260
/** 收缩宽度。 */
export const WIDTH_COLLAPSED = 56
/** 拉伸下限 / 上限。 */
export const WIDTH_MIN = 220
export const WIDTH_MAX = 420
/** 松手后写回持久化的防抖时长。 */
export const WRITE_DEBOUNCE_MS = 300

/** 宽屏断点：≥ 此值才允许展开与拉伸。 */
export const BREAKPOINT_WIDE = 1024
/** 中屏断点：≥ 此值且 < BREAKPOINT_WIDE 为强制收缩。 */
export const BREAKPOINT_MID = 768

/** 把宽度夹取到 [WIDTH_MIN, WIDTH_MAX]；非数字回落展开默认值。 */
export function clampWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WIDTH_EXPANDED
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(value)))
}

/** 断点归类：`wide`（≥1024）/ `mid`（768–1023）/ `narrow`（<768）。 */
export function breakpointOf(viewportWidth: unknown): 'wide' | 'mid' | 'narrow' {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth)) return 'wide'
  if (viewportWidth >= BREAKPOINT_WIDE) return 'wide'
  if (viewportWidth >= BREAKPOINT_MID) return 'mid'
  return 'narrow'
}

/** 是否允许展开 / 拉伸（仅宽屏）。 */
export function canResize(viewportWidth: unknown): boolean {
  return breakpointOf(viewportWidth) === 'wide'
}

/** 强制收缩：非宽屏一律收缩，忽略用户偏好。 */
export function resolveCollapsed(viewportWidth: unknown, userCollapsed: unknown): boolean {
  if (!canResize(viewportWidth)) return true
  return userCollapsed === true
}

/** 有效宽度：非宽屏恒为收缩宽度；宽屏按用户偏好取展开（夹取持久值）或收缩。 */
export function effectiveWidth(viewportWidth: unknown, storedWidth: unknown, collapsed: unknown): number {
  if (!canResize(viewportWidth)) return WIDTH_COLLAPSED
  if (collapsed === true) return WIDTH_COLLAPSED
  return clampWidth(storedWidth)
}

/** 拉伸新宽度：在夹取范围内按指针位移增量计算（不吸附、无动画）。 */
export function widthFromDrag(startWidth: unknown, deltaX: unknown): number {
  return clampWidth(clampWidth(startWidth) + (typeof deltaX === 'number' && Number.isFinite(deltaX) ? deltaX : 0))
}
