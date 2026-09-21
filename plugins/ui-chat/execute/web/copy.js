// 复制反馈状态机（纯函数）：成功就地 copy → check，保持 1.2s 回退；失败 → alert-circle。
// 图标交叉淡化 100ms 是 CSS 层时长，这里只管状态与回退时刻。

export const COPY_HOLD_MS = 1200
export const COPY_FADE_MS = 100

/** 创建复制反馈状态；`now` 可注入假时钟便于单测。 */
export function createCopyState(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let state = { status: 'idle', since: 0, revertAt: null }
  const api = {
    get() {
      return { ...state }
    },
    success() {
      const at = now()
      state = { status: 'check', since: at, revertAt: at + COPY_HOLD_MS }
      return api.get()
    },
    fail() {
      state = { status: 'error', since: now(), revertAt: null }
      return api.get()
    },
    reset() {
      state = { status: 'idle', since: 0, revertAt: null }
      return api.get()
    },
    /** 到期回退（由调用方定时驱动）。 */
    tick(at) {
      const current = typeof at === 'number' ? at : now()
      if (state.status === 'check' && state.revertAt !== null && current >= state.revertAt) {
        state = { status: 'idle', since: 0, revertAt: null }
      }
      return api.get()
    },
  }
  return api
}
