// 本插件 `/events` SSE 订阅：宿主事件原样重播（impl 命名空间）+ 本插件连接态。
// 用于跨 slot / 编排健康更新，避免只在进入编排 tab 时才轮询；unmount 时关闭。

export function connectEvents(ctx) {
  let source = null
  try {
    source = new EventSource(new URL('events', import.meta.url).href)
  } catch {
    return () => {}
  }
  source.onmessage = (event) => {
    let record
    try {
      record = JSON.parse(event.data)
    } catch {
      return
    }
    if (record === null || typeof record !== 'object') return
    handleRecord(ctx, record)
  }
  source.onerror = () => {
    // EventSource 自带重连；连接态由 settings.state 事件与 /api/state 决定。
  }
  return () => {
    try {
      source.close()
    } catch {
      // 关闭失败不影响卸载
    }
  }
}

function handleRecord(ctx, record) {
  // 编排不健康事件（由 evolve-metrics 周期发出，thread:null）：无需打开编排页即刷新健康与角标。
  if (record.topic === 'orchestration.unhealthy') {
    void ctx.loadHealth()
  }
}
