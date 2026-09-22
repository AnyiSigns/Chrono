// hover 意图延时的纯状态机：`hidden → showing →(150ms) visible →(leave) hiding →(300ms) hidden`。
// 鼠标划过顶部热区不立刻展开（防误触）；移出后延时收起，期间回入即取消收起。
// 只描述状态迁移与应排定的延时，计时器由调用方持有（便于单测）。

/** 出（展开）意图延时。 */
export const HOVER_SHOW_MS = 150

/** 收（隐藏）意图延时。 */
export const HOVER_HIDE_MS = 300

/** 状态取值：`hidden` / `showing` / `visible` / `hiding`。 */
export const HOVER_STATUSES = ['hidden', 'showing', 'visible', 'hiding']

/**
 * 迁移一次：`event` ∈ `enter` / `leave` / `timeout`。
 * 非法状态 / 事件回原状态（不抛错）。
 */
export function nextHoverStatus(status, event) {
  if (!HOVER_STATUSES.includes(status)) return 'hidden'
  if (status === 'hidden') return event === 'enter' ? 'showing' : 'hidden'
  if (status === 'showing') {
    if (event === 'leave') return 'hidden'
    if (event === 'timeout') return 'visible'
    return 'showing'
  }
  if (status === 'visible') return event === 'leave' ? 'hiding' : 'visible'
  // hiding
  if (event === 'enter') return 'visible'
  if (event === 'timeout') return 'hidden'
  return 'hiding'
}

/** 进入该状态后应排定的延时（ms）；无需计时返回 null。 */
export function hoverDelay(status) {
  if (status === 'showing') return HOVER_SHOW_MS
  if (status === 'hiding') return HOVER_HIDE_MS
  return null
}

/** 该状态是否展开（overlay 可见）。 */
export function isHoverOpen(status) {
  return status === 'visible'
}
