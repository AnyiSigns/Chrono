// 长列表窗口化与「↓ N 条新消息」状态机（纯函数）。
// >200 条只渲染一个窗口；滚顶拉上一窗；贴底自动贴底、上滑冻结才出胶囊。

import { formatText } from './messages.ts'

export const WINDOW_SIZE = 200
export const WINDOW_THRESHOLD = 200
/** 渲染窗口条数上限：超过即回收远端，长历史下限制常驻 DOM（< 上限的历史永不回收）。 */
export const MAX_WINDOW = 600

/** 是否需要窗口化（消息数 > 200）。 */
export function shouldWindow(total: number): boolean {
  return total > WINDOW_THRESHOLD
}

/** 初始窗口：最新一窗（尾部对齐）。 */
export function initialWindow(total: number, size = WINDOW_SIZE): { start: number; end: number } {
  const end = Math.max(0, total)
  return { start: Math.max(0, end - size), end }
}

/** 向上翻一窗；已到顶返回 null（调用方显示「没有更多了」）。 */
export function olderWindow(state: { start: number; end: number }, size = WINDOW_SIZE): { start: number; end: number } | null {
  if (state.start <= 0) return null
  return { start: Math.max(0, state.start - size), end: state.end }
}

/** 是否还有更早的消息。 */
export function hasOlder(state: { start: number; end: number }): boolean {
  return state.start > 0
}

/** 是否还有更新的消息。 */
export function hasNewer(state: { start: number; end: number }, total: number): boolean {
  return state.end < total
}

/** 窗口当前条数。 */
export function windowSize(state: { start: number; end: number }): number {
  return Math.max(0, state.end - state.start)
}

/** 向下扩一窗（看更新消息）；已到底返回 null。 */
export function newerWindow(
  state: { start: number; end: number },
  total: number,
  size = WINDOW_SIZE,
): { start: number; end: number } | null {
  if (state.end >= total) return null
  return { start: state.start, end: Math.min(total, state.end + size) }
}

/** 回收窗口底部（上翻后）：保留 [start, start+max]。返回新窗口与裁掉条数。 */
export function trimBottom(
  state: { start: number; end: number },
  max = MAX_WINDOW,
): { state: { start: number; end: number }; removed: number } {
  if (windowSize(state) <= max) return { state, removed: 0 }
  const end = state.start + max
  return { state: { start: state.start, end }, removed: state.end - end }
}

/** 回收窗口顶部（下翻后）：保留 [end-max, end]。返回新窗口与裁掉条数。 */
export function trimTop(
  state: { start: number; end: number },
  max = MAX_WINDOW,
): { state: { start: number; end: number }; removed: number } {
  if (windowSize(state) <= max) return { state, removed: 0 }
  const start = state.end - max
  return { state: { start, end: state.end }, removed: start - state.start }
}

/** 窗口内切片。 */
export function sliceWindow<T>(items: T[], state: { start: number; end: number }): T[] {
  return items.slice(state.start, state.end)
}

/** 新消息胶囊状态：贴底时清零，上滑冻结时累计。 */
export function createNewMessageState(): { count: number } {
  return { count: 0 }
}

export function onNewContent(state: { count: number }, atBottom: boolean): { count: number } {
  if (atBottom) return { count: 0 }
  return { count: state.count + 1 }
}

export function dismissNew(): { count: number } {
  return { count: 0 }
}

export function pillLabel(count: number): string {
  return formatText('chat_new_messages_pill', { count })
}
