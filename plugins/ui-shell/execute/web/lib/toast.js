// 全局 toast 队列（纯逻辑，时钟可注入）：右下角堆叠、最多同屏 3 条、超出排队；
// info/success 2.5s、warning/danger 4s 自动消失；带 action 不自动消失；hover 暂停计时。

export const TOAST_MAX_VISIBLE = 3

export const TOAST_DURATIONS = { info: 2500, success: 2500, warning: 4000, danger: 4000 }

export const TOAST_TONES = ['info', 'success', 'warning', 'danger']

/** toast 的 aria-live 语义：info/success = status（polite），warning/danger = alert。 */
export function roleForTone(tone) {
  return tone === 'warning' || tone === 'danger' ? 'alert' : 'status'
}

function normalizeTone(tone) {
  return TOAST_TONES.includes(tone) ? tone : 'info'
}

/**
 * 创建 toast 队列。
 * @param {{ now?: () => number }} [options] 时钟（测试注入；缺省 Date.now）
 */
export function createToastQueue(options) {
  const now = options && typeof options.now === 'function' ? options.now : () => Date.now()
  const items = []
  let counter = 0

  function activeCount() {
    let count = 0
    for (const item of items) if (item.started) count += 1
    return count
  }

  function promote(at) {
    for (const item of items) {
      if (activeCount() >= TOAST_MAX_VISIBLE) break
      if (item.started) continue
      item.started = true
      item.deadline = item.durationMs === null ? null : at + item.durationMs
    }
  }

  /** 结算到期项 + 提升排队项；返回当前可见列表。 */
  function refresh(at) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (!item.started || item.deadline === null || item.paused) continue
      if (at >= item.deadline) items.splice(index, 1)
    }
    promote(at)
    return visible()
  }

  function visible() {
    return items.filter((item) => item.started)
  }

  function queued() {
    return items.filter((item) => !item.started)
  }

  return {
    enqueue(input) {
      const tone = normalizeTone(input && input.tone)
      const text = typeof (input && input.text) === 'string' ? input.text : ''
      const action = input && input.action !== undefined ? input.action : null
      counter += 1
      const item = {
        id: `toast-${counter}`,
        tone,
        text,
        action,
        durationMs: action === null ? (TOAST_DURATIONS[tone] ?? 2500) : null,
        started: false,
        deadline: null,
        paused: false,
        remainingMs: null,
      }
      items.push(item)
      promote(now())
      return item.id
    },
    visible,
    queued,
    all() {
      return items.slice()
    },
    visibleCount() {
      return activeCount()
    },
    /** 到期结算 + 排队提升（壳页面按动画帧 / 定时器调用）。 */
    tick(at) {
      return refresh(typeof at === 'number' ? at : now())
    },
    dismiss(id) {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return false
      items.splice(index, 1)
      promote(now())
      return true
    },
    /** hover 暂停 / 恢复：暂停时保留剩余时长，恢复后顺延。 */
    hover(id, hovering) {
      const item = items.find((entry) => entry.id === id)
      if (item === undefined || item.durationMs === null) return
      const at = now()
      if (hovering && !item.paused) {
        item.paused = true
        item.remainingMs = item.deadline === null ? item.durationMs : Math.max(0, item.deadline - at)
        item.deadline = null
      } else if (!hovering && item.paused) {
        item.paused = false
        item.deadline = at + (item.remainingMs ?? item.durationMs)
        item.remainingMs = null
      }
    },
    clear() {
      items.length = 0
    },
  }
}
