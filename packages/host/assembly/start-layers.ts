// 装配启动分层：把「被依赖者先」的线性启动序切成依赖层，同层并发、层间顺序。
// 层号 = 该身份依赖链的最长深度，故任一身份的全部依赖都落在更早的层：同层之间没有依赖边，
// 层内并发不会让任何身份读到尚未装载的依赖（依赖装载状态只在层边界推进）。
// 启动序本身已由闭包的逆拓扑序保证「被依赖者先」，本模块只在其上做机械分层，不改拓扑。

/**
 * 同层并发上限：单次启动可能触发 npm / cargo 构建并 spawn 整棵进程树。
 * 不设上限会让 30+ 个构建同时开跑，打满 CPU / IO，且多个 cargo 争抢同一 target 目录锁；
 * 上限只约束「同时在物化 / 构建 / 握手的身份数」，不改变分层与顺序语义。
 */
export const DEFAULT_START_CONCURRENCY = 4

/**
 * 按启动序计算依赖层：层号 = 1 + max(依赖的层号)。
 * 不在启动序内的依赖（被闭包隔离）不参与分层——该身份启动时会因依赖未装载按 `dep stale` 处理，
 * 与串行序下的结果一致。启动序保证依赖先出现，故单趟扫描即可定层。
 */
export function computeStartLayers(
  order: readonly string[],
  depsOf: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const inOrder = new Set(order)
  const level = new Map<string, number>()
  const layers: string[][] = []
  for (const id of order) {
    let depth = 0
    for (const dep of depsOf.get(id) ?? []) {
      if (!inOrder.has(dep)) continue
      depth = Math.max(depth, (level.get(dep) ?? 0) + 1)
    }
    level.set(id, depth)
    while (layers.length <= depth) layers.push([])
    layers[depth].push(id)
  }
  return layers
}

/**
 * 有上限的并发执行：保持同一层全部任务完成后才返回。
 * 固定数量 worker 从队列取任务，故同时最多 `limit` 个任务在跑；`limit` 非正数按 1 处理。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const queue = [...items]
  const width = Math.max(1, Math.min(Math.floor(limit), queue.length))
  const workers = Array.from({ length: width }, async () => {
    while (queue.length > 0) {
      const item = queue.shift() as T
      await task(item)
    }
  })
  await Promise.all(workers)
}
