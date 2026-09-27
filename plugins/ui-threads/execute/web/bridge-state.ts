// `current` ↔ `active_thread` 单桥的纯逻辑：
// 侧栏 `session.select` / 删除会话落账后 session 发 `thread.updated`（含 `current` 变）；
// 顶栏重算 `threads.state` 后，仅当 `current` 变了（或尚未选定）才把 `active_thread` 重置到它。
// `current` 变为 null（删到无当前会话）时把 `active_thread` 一并清空，回空态而非滞留已删会话。
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
  // 无当前会话：active_thread 一并清空（reset 仅在确有值可清时为真，避免空写）。
  if (current === null) return { activeThread: null, knownCurrent: null, reset: active !== null }
  if (active === null) return { activeThread: current, knownCurrent: current, reset: true }
  if (current !== known) return { activeThread: current, knownCurrent: current, reset: true }
  return { activeThread: active, knownCurrent: current, reset: false }
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
