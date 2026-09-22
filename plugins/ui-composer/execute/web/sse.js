// 壳事件总线订阅：宿主事件原样重播（impl 命名空间）+ 壳连接态。
// 输入卡关心 `run.started` / `run.finished` / `context.assembled`（按线程过滤），unmount 时退订。

export function connectEvents(api, onRecord) {
  if (typeof api?.events?.onAny !== 'function') return () => {}
  return api.events.onAny(onRecord)
}
