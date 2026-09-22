// 本插件自己的 SSE 面：`GET /events` 把宿主事件原样重播给本页。
// 浏览器不能直连宿主本地 socket，故本插件服务持有自己的入站连接、把事件经 HTTP SSE 转发。
// 事件命名空间保持宿主原样（`impl` + `topic`），本页按 topic 过滤（侧栏只关心状态类事件）。

/** 一条 SSE 数据帧（`data: <json>\n\n`）；JSON 内换行安全（单行序列化）。 */
export function encodeSseRecord(record) {
  return `data: ${JSON.stringify(record)}\n\n`
}

/** 本插件运行态事件：入站连接态（供页面显示断线）；`impl` 由插件身份传入。 */
export function sidebarStateRecord(connected, impl) {
  return { impl, topic: 'sidebar.state', payload: { connected } }
}

/** 已连接 SSE 客户端集合；广播是「尽力而为」（写失败即摘除）。 */
export class SseHub {
  constructor() {
    this.sinks = new Set()
  }

  add(sink) {
    this.sinks.add(sink)
  }

  remove(sink) {
    this.sinks.delete(sink)
  }

  count() {
    return this.sinks.size
  }

  /** 广播一条记录；单条写失败不阻断其余。 */
  broadcast(record) {
    const chunk = encodeSseRecord(record)
    for (const sink of [...this.sinks]) {
      try {
        sink.write(chunk)
      } catch {
        this.sinks.delete(sink)
      }
    }
  }

  /** 宿主事件原样重播（impl = 上报身份 / `host`）。 */
  hostEvent(impl, topic, payload) {
    this.broadcast({ impl, topic, payload })
  }
}
