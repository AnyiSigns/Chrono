// `current` ↔ `active_thread` 单桥的纯逻辑：
// 侧栏 `session.select` 落账后 #11 发 `thread.updated`（含 `current` 变）；
// 顶栏重算 `threads.state` 后，仅当 `current` 变了（或尚未选定）才把 `active_thread` 重置到它。
// 纯模块：无 DOM、无 react import。

export interface ResolveActiveThreadInput {
  current?: unknown
  knownCurrent?: unknown
  activeThread?: unknown
}

export interface ResolvedActiveThread {
  activeThread: string | null
  knownCurrent: string | null
  reset: boolean
}

/** 依据 `threads.state` 返回的 `current` 解析新的 `active_thread`。 */
export function resolveActiveThread(input: unknown): ResolvedActiveThread {
  const source =
    typeof input === 'object' && input !== null ? (input as ResolveActiveThreadInput) : {}
  const current = normalizeId(source.current)
  const known = normalizeId(source.knownCurrent)
  const active = normalizeId(source.activeThread)
  if (current === null) return { activeThread: active, knownCurrent: known, reset: false }
  if (active === null) return { activeThread: current, knownCurrent: current, reset: true }
  if (current !== known) return { activeThread: current, knownCurrent: current, reset: true }
  return { activeThread: active, knownCurrent: current, reset: false }
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
