// React-free 业务状态 store：唯一真源 + 变更通知。
// 契约形状 `{ getSnapshot(), subscribe(listener), commit() }`；壳经 `ctx.useStore` 绑定。
// 视图态住 `state`（可变对象）；`commit()` 递增版本号并广播，React 据此重渲染。

export interface SettingsStore {
  getSnapshot(): number
  subscribe(listener: () => void): () => void
  commit(): void
}

export function createStore(): SettingsStore {
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit: () => {
      revision += 1
      for (const listener of [...listeners]) listener()
    },
  }
}
