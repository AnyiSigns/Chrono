// 世界落点的写入原语：把「锚定 expect_pos → 独占世界副本 → 内核 commit → 落账」收成一处。
// 两个串行上下文共用：进程内 `WorldWriter` 段内的世界（提交前克隆，装配运行时持有原引用做换代比对）
// 与离线持锁时调用方独占的锚点世界（就地演化，不克隆）。落账失败统一标记进程级致命并抛出。

import { cloneWorld, commit } from '../kernel/index.ts'
import type { Entry, Hash, Head, World, WriteRequest } from '../kernel/index.ts'
import { markFatal } from './effect/fatal.ts'

/**
 * 世界落点的串行上下文。
 * - `writer`：`WorldWriter.run` 段内的世界；提交前克隆独占副本，原引用仍归装配运行时。
 * - `lock`：离线持锁时调用方独占的锚点世界；提交就地演化，不克隆。
 */
export type WorldLanding =
  { kind: 'writer'; world: World; head: Head } | { kind: 'lock'; world: World; head: Head }

/** 一次提交的定论：`committed` 已落账并推进链头；`unchanged` 幂等命中；`refused` 内核拒绝。 */
export type WorldCommitResult =
  | { kind: 'committed'; entry: Entry; hash: Hash; world: World; head: Head }
  | { kind: 'unchanged'; world: World; head: Head }
  | { kind: 'refused'; reasons: string[]; world: World; head: Head }

/**
 * 提交一条写请求到世界落点。
 * `expect_pos` 一律锚到 `landing.head.hash`，调用方无需预填；被拒 / 幂等命中时世界与链头不变。
 * @param landing 串行上下文；决定是否克隆世界
 * @param request 写请求（不含 `target`，由本函数锚定）
 * @param now 时间戳（内核不自读时钟）
 * @param persist 落账回调：把提交产物写到账本；抛错即致命（标记进程级致命后原样抛出）
 */
export function commitToWorld(
  landing: WorldLanding,
  request: Omit<WriteRequest, 'target'>,
  now: number,
  persist: (entry: Entry) => void,
): WorldCommitResult {
  const anchored: WriteRequest = { ...request, target: { expect_pos: landing.head.hash } }
  const world = landing.kind === 'writer' ? cloneWorld(landing.world) : landing.world
  const outcome = commit(landing.head, world, anchored, now)
  if (!outcome.verdict.ok) {
    return {
      kind: 'refused',
      reasons: outcome.verdict.reasons,
      world: landing.world,
      head: landing.head,
    }
  }
  if (outcome.entry === null || outcome.hash === null) {
    return { kind: 'unchanged', world: landing.world, head: landing.head }
  }
  const entry = outcome.entry
  const head: Head = { seq: entry.seq, hash: outcome.hash }
  try {
    persist(entry)
  } catch (err) {
    markFatal(err)
    throw err
  }
  return { kind: 'committed', entry, hash: outcome.hash, world, head }
}
