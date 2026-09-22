// 未读角标的纯计数（视图态、不落世界）：内存计数，刷新即丢。
// `group.message` 到达且线程 ≠ 当前 `active_thread` 时 +1；切入该线程即清零。

/** 不可变 +1：目标线程为空 / 就是当前线程时不计数。 */
export function bumpUnread(counts, thread, activeThread) {
  if (typeof thread !== 'string' || thread.length === 0) return counts
  if (thread === activeThread) return counts
  const next = { ...counts }
  next[thread] = (next[thread] ?? 0) + 1
  return next
}

/** 不可变清零：该线程无计数时原样返回。 */
export function clearUnread(counts, thread) {
  if (typeof thread !== 'string' || counts[thread] === undefined || counts[thread] === 0) return counts
  const next = { ...counts }
  next[thread] = 0
  return next
}

/** 取线程未读数（非正 / 缺失回 0）。 */
export function unreadOf(counts, thread) {
  const value = typeof counts === 'object' && counts !== null ? counts[thread] : undefined
  return typeof value === 'number' && value > 0 ? value : 0
}
