// 跨 slot 视图状态 `api.uiState`：纯前端内存态，键空间由壳登记，跨 slot 广播。
// 刷新即丢、不落世界、不占事件通道；壳只做键值广播，不认识业务。

/** 已登记的状态键（新增键须先登记）。 */
export const UI_STATE_KEYS = ['active_thread', 'boot_mode', 'settings_open']

/** 创建一份壳内存态；get / set / subscribe 三面。 */
export function createUiState() {
  const values = new Map()
  const listeners = new Map()

  function set(key, value) {
    // 键空间由壳登记；未登记键告警并忽略（DESIGN「新增键须先登记」）。
    if (!UI_STATE_KEYS.includes(key)) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`uiState: 未登记的状态键「${key}」已忽略；新增键须先在 UI_STATE_KEYS 登记`)
      }
      return false
    }
    values.set(key, value)
    const subs = listeners.get(key)
    if (subs === undefined) return true
    for (const callback of [...subs]) {
      try {
        callback(value, key)
      } catch {
        // 单个订阅者抛错不影响其余广播
      }
    }
    return true
  }

  function subscribe(key, callback) {
    let subs = listeners.get(key)
    if (subs === undefined) {
      subs = new Set()
      listeners.set(key, subs)
    }
    subs.add(callback)
    return () => {
      subs.delete(callback)
    }
  }

  return {
    keys: UI_STATE_KEYS.slice(),
    get(key) {
      return values.get(key)
    },
    has(key) {
      return values.has(key)
    },
    set,
    subscribe,
    snapshot() {
      const out = {}
      for (const [key, value] of values) out[key] = value
      return out
    },
  }
}
