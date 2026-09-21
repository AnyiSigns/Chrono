// 本插件自己的 SSE 面：`GET /events` 把宿主事件原样重播给本页。
// 浏览器不能直连宿主本地 socket，故本插件服务持有自己的入站连接、把事件经 HTTP SSE 转发。
// 事件命名空间保持宿主原样（`impl` + `topic`），本页按 topic 过滤（引导 / 设置页只关心少量事件）。

import type { Json } from './types.ts'

export interface SseRecord {
  impl: string
  topic: string
  payload: Json
}

export interface SseSink {
  write(chunk: string): void
}

/** 一条 SSE 数据帧（`data: <json>\n\n`）；JSON 内换行安全（单行序列化）。 */
export function encodeSseRecord(record: SseRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`
}

/** 本插件运行态事件：入站连接态（供页面显示加载 / 断线）；`impl` 由插件身份传入。 */
export function settingsStateRecord(connected: boolean, impl: string): SseRecord {
  return { impl, topic: 'settings.state', payload: { connected } }
}

/** 已连接 SSE 客户端集合；广播是「尽力而为」（写失败即摘除）。 */
export class SseHub {
  private readonly sinks = new Set<SseSink>()

  add(sink: SseSink): void {
    this.sinks.add(sink)
  }

  remove(sink: SseSink): void {
    this.sinks.delete(sink)
  }

  count(): number {
    return this.sinks.size
  }

  /** 广播一条记录；单条写失败不阻断其余。 */
  broadcast(record: SseRecord): void {
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
  hostEvent(impl: string, topic: string, payload: Json): void {
    this.broadcast({ impl, topic, payload })
  }
}
