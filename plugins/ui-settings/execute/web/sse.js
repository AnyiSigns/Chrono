// 壳事件总线订阅：宿主事件原样重播（impl 命名空间）+ 壳连接态。
// 用于跨 slot / 编排健康更新，避免只在进入编排 tab 时才轮询；unmount 时退订。

export function connectEvents(api, ctx) {
  if (typeof api?.events?.onAny !== 'function') return () => {}
  return api.events.onAny((record) => handleRecord(ctx, record))
}

function handleRecord(ctx, record) {
  // 编排不健康事件（由 evolve-metrics 周期发出，thread:null）：无需打开编排页即刷新健康与角标。
  if (record.topic === 'orchestration.unhealthy') {
    void ctx.loadHealth()
  }
}
