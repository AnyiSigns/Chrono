// 壳事件总线订阅：宿主事件原样重播（impl 命名空间）+ 壳连接态。
// 审批条只关心 `approval.pending` / `approval.decided`（卡片态由宿主事件驱动），unmount 时退订。

export function connectEvents(api, onRecord) {
  if (typeof api?.events?.onAny !== 'function') return () => {}
  return api.events.onAny(onRecord)
}
