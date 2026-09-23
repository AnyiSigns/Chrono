// 长列表窗口化与「↓ N 条新消息」状态机（纯函数）。
// >200 条只渲染一个窗口；滚顶拉上一窗；贴底自动贴底、上滑冻结才出胶囊。

import { formatText } from './messages.ts'

export const WINDOW_SIZE = 200
export const WINDOW_THRESHOLD = 200

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
