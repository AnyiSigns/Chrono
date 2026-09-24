// slot 注册簿：纯簿记（无 React / 无 DOM），可脱离浏览器单测。
// 负责目标归一、装载代号（epoch）拒绝、幂等替换的条目表与 outlet 元素绑定；
// 渲染与 React 根生命周期由 slots.js 承担——注册簿只决定「该卸哪些旧条目 / 该渲哪些新条目」。

function isName(value) {
  return typeof value === 'string' && value.length > 0
}

/** 目标归一：字符串或 `{name, children}` 都接受；非法回 null（`children` 只留合法名）。 */
export function normalizeTarget(target) {
  if (isName(target)) return { name: target, children: [] }
  if (target !== null && typeof target === 'object' && isName(target.name)) {
    const children = Array.isArray(target.children)
      ? target.children.filter((item) => isName(item))
      : []
    return { name: target.name, children }
  }
  return null
}

/**
 * 建注册簿。`options.currentEpoch(pluginId)` 提供当前装载代号：与传入 epoch 不符即拒注册
 * （超时重挂后迟到的 register 被丢弃，只保留当前在途装载的一份）。
 * 条目形状 `{ pluginId, payload, container, mounted }`，`container` / `mounted` 由调用方渲染层维护。
 */
export function createSlotRegistry(options = {}) {
  const currentEpoch = typeof options.currentEpoch === 'function' ? options.currentEpoch : null
  const slots = new Map()

  function slotOf(name) {
    let slot = slots.get(name)
    if (slot === undefined) {
      slot = { name, element: null, entries: [] }
      slots.set(name, slot)
    }
    return slot
  }

  return {
    slotOf,
    entries(name) {
      const slot = slots.get(name)
      return slot === undefined ? [] : slot.entries
    },
    elementOf(name) {
      const slot = slots.get(name)
      return slot === undefined ? null : slot.element
    },
    /**
     * 注册一个条目（幂等）：同插件同 slot 的旧条目先移出并随 `removed` 返回，由调用方卸载其 React 根。
     * 目标非法 / epoch 陈旧 → `{ok:false}` 且 `removed` 恒空。成功回 `{ok:true, name, removed}`。
     */
    register(pluginId, target, epoch, payload) {
      const normalized = normalizeTarget(target)
      if (normalized === null) return { ok: false, reason: 'bad_target', name: null, removed: [] }
      if (typeof epoch === 'number' && currentEpoch !== null) {
        const current = currentEpoch(pluginId)
        if (typeof current === 'number' && current !== epoch) {
          return { ok: false, reason: 'stale', name: null, removed: [] }
        }
      }
      for (const child of normalized.children) slotOf(child)
      const slot = slotOf(normalized.name)
      const removed = slot.entries.filter((item) => item.pluginId === pluginId)
      slot.entries = slot.entries.filter((item) => item.pluginId !== pluginId)
      slot.entries.push({ pluginId, payload, container: null, mounted: false })
      return { ok: true, reason: '', name: normalized.name, removed }
    },
    /** 移出一个插件在某 slot 的条目；返回被移出的条目（调用方据此卸载）。 */
    remove(pluginId, name) {
      const slot = slots.get(name)
      if (slot === undefined) return []
      const removed = slot.entries.filter((item) => item.pluginId === pluginId)
      slot.entries = slot.entries.filter((item) => item.pluginId !== pluginId)
      return removed
    },
    /** 绑定 / 解绑 outlet 元素；返回该 slot（调用方据 `entries` 决定渲染）。 */
    setElement(name, element) {
      const slot = slotOf(name)
      slot.element = element
      return slot
    },
  }
}
