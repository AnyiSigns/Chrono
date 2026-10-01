// React-free store 原语：壳经 `ctx.useStore(store)` 以 useSyncExternalStore 绑定。
// 各插件的会话 / 视图状态快照形状不同，故这里只承载「快照 + 订阅 + 换引用提交」，
// 具体 fold 由消费方以纯函数在外部完成。

export interface ReadableStore<S> {
  getSnapshot(): S
  subscribe(listener: (snapshot: S) => void): () => void
}

export interface Store<S> extends ReadableStore<S> {
  commit(next: S, meta?: unknown): void
}

/** 建一个 store：快照不可变，`commit` 整体替换引用并逐个通知订阅者。 */
export function createStore<S>(initial: S): Store<S> {
  let snapshot = initial
  const listeners = new Set<(value: S) => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit(next) {
      snapshot = next
      for (const listener of [...listeners]) listener(snapshot)
    },
  }
}
