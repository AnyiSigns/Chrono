// 未读角标的纯计数（视图态、不落世界）：内存计数，刷新即丢。
// `group.message` 到达且线程 ≠ 当前 `active_thread` 时 +1；切入该线程即清零。
// 纯模块：无 DOM、无 react import。

export type UnreadCounts = { [thread: string]: number }

/** 不可变 +1：目标线程为空 / 就是当前线程时不计数。 */
export function bumpUnread(counts: UnreadCounts, thread: unknown, activeThread: unknown): UnreadCounts {
  if (typeof thread !== 'string' || thread.length === 0) return counts
  if (thread === activeThread) return counts
  const next: UnreadCounts = { ...counts }
  next[thread] = (next[thread] ?? 0) + 1
  return next
}

/** 不可变清零：该线程无计数时原样返回。 */
export function clearUnread(counts: UnreadCounts, thread: unknown): UnreadCounts {
  if (typeof thread !== 'string' || counts[thread] === undefined || counts[thread] === 0) return counts
  const next: UnreadCounts = { ...counts }
  next[thread] = 0
  return next
}

/** 取线程未读数（非正 / 缺失回 0）。 */
export function unreadOf(counts: UnreadCounts, thread: unknown): number {
  const value = typeof counts === 'object' && counts !== null ? counts[thread as string] : undefined
  return typeof value === 'number' && value > 0 ? value : 0
}

/** 未读总数（跨线程求和，非正忽略）。 */
export function unreadTotal(counts: UnreadCounts): number {
  let total = 0
  for (const key of Object.keys(counts)) {
    const value = counts[key]
    if (typeof value === 'number' && value > 0) total += value
  }
  return total
}
