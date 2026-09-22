// `current` ↔ `active_thread` 单桥的纯逻辑：
// 侧栏 `session.select` 落账后 #11 发 `thread.updated`（含 `current` 变）；
// 顶栏重算 `threads.state` 后，仅当 `current` 变了（或尚未选定）才把 `active_thread` 重置到它。

/**
 * 依据 `threads.state` 返回的 `current` 解析新的 `active_thread`。
 * @param {{current?: unknown, knownCurrent?: unknown, activeThread?: unknown}} input
 * @returns {{activeThread: string|null, knownCurrent: string|null, reset: boolean}}
 */
export function resolveActiveThread(input) {
  const source = typeof input === 'object' && input !== null ? input : {}
  const current = normalizeId(source.current)
  const known = normalizeId(source.knownCurrent)
  const active = normalizeId(source.activeThread)
  if (current === null) return { activeThread: active, knownCurrent: known, reset: false }
  if (active === null) return { activeThread: current, knownCurrent: current, reset: true }
  if (current !== known) return { activeThread: current, knownCurrent: current, reset: true }
  return { activeThread: active, knownCurrent: current, reset: false }
}

function normalizeId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}
