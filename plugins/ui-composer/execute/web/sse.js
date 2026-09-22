// 本插件 `/events` SSE 订阅：宿主事件原样重播（impl 命名空间）+ 本插件连接态。
// 输入卡关心 `run.started` / `run.finished` / `context.assembled`（按线程过滤），unmount 时关闭。

export function connectEvents(onRecord) {
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
    onRecord(record)
  }
  source.onerror = () => {
    // EventSource 自带重连；连接态由 composer.state 事件与 /api/state 决定。
  }
  return () => {
    try {
      source.close()
    } catch {
      // 关闭失败不影响卸载
    }
  }
}
