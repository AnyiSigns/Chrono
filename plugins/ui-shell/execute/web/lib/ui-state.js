// 跨 slot 视图状态 `api.uiState`：纯前端内存态，键空间由壳登记，跨 slot 广播。
// 刷新即丢、不落世界、不占事件通道；壳只做键值广播，不认识业务。
// 键空间可静态登记（UI_STATE_KEYS / registerKey）或随引导数据一次登记（createUiState(initialKeys)），
// 于是新增 overlay / 页面无需改壳源码，其键由壳按 nav 数据注入。

/** 已登记的状态键（壳内置键；新增键可经 `registerKey` 或引导数据登记）。 */
export const UI_STATE_KEYS = ['active_thread', 'active_workspace', 'boot_mode', 'settings_open']

/** 状态键名形态：小写字母起头，后续小写字母 / 数字 / 下划线（与 nav 目标键同口径）。 */
const KEY_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 登记一个状态键；形态非法返回 false，已登记返回 true（幂等）。 */
export function registerKey(key) {
  if (typeof key !== 'string' || !KEY_NAME_RE.test(key)) return false
  if (!UI_STATE_KEYS.includes(key)) UI_STATE_KEYS.push(key)
  return true
}

/** 创建一份壳内存态；get / set / subscribe 三面。`initialKeys` 为引导数据注入的键空间。 */
export function createUiState(initialKeys) {
  const keys = new Set(UI_STATE_KEYS)
  if (Array.isArray(initialKeys)) {
    for (const key of initialKeys) {
      if (typeof key === 'string' && KEY_NAME_RE.test(key)) keys.add(key)
    }
  }
  const values = new Map()
  const listeners = new Map()

  function set(key, value) {
    // 键空间由壳登记；未登记键告警并忽略（静态登记或经引导数据注入）。
    if (!keys.has(key)) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`uiState: 未登记的状态键「${key}」已忽略；新增键须先经 registerKey 或引导数据登记`)
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
    keys: [...keys],
    registerKey(key) {
      if (typeof key !== 'string' || !KEY_NAME_RE.test(key)) return false
      keys.add(key)
      return true
    },
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
