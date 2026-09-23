// 壳 SSE：`GET /events` 的事件流编码与广播中心（docs/protocol.md §2.5）。
// 宿主事件原样重播（`impl` 命名空间）+ 壳自身状态（连接态 / 主题）+ 壳合成事件
// `shell.disconnected` / `shell.reconnected`（断连 / 重连时注入）。

import type { Json } from './types.ts'

/** 壳自身事件的命名空间。 */
export const SHELL_IMPL = 'shell'

export interface SseRecord {
  impl: string
  topic: string
  payload: Json
}

export interface SseSink {
  write(chunk: string): void
  /** 优雅收尾（可选）：停机时发终止块，避免浏览器报 ERR_INCOMPLETE_CHUNKED_ENCODING。 */
  end?(): void
}

/** 一条 SSE 数据帧（`data: <json>\n\n`）；JSON 内换行安全（单行序列化）。 */
export function encodeSseRecord(record: SseRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`
}

/** 壳状态事件：连接态 + 当前主题（供子应用首屏校正与断线判断）。 */
export function shellStateRecord(connected: boolean, theme: string): SseRecord {
  return { impl: SHELL_IMPL, topic: 'shell.state', payload: { connected, theme } }
}

/** 壳合成事件：断连 / 重连。 */
export function syntheticEventsFor(
  prevConnected: boolean,
  nextConnected: boolean,
  hasDisconnected: boolean,
): SseRecord[] {
  if (prevConnected && !nextConnected) {
    return [{ impl: SHELL_IMPL, topic: 'shell.disconnected', payload: {} }]
  }
  if (!prevConnected && nextConnected && hasDisconnected) {
    return [{ impl: SHELL_IMPL, topic: 'shell.reconnected', payload: {} }]
  }
  return []
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

  /**
   * 停机收尾：给所有 SSE 客户端发终止块再摘除。
   * 直接 destroy socket 会让浏览器记 `ERR_INCOMPLETE_CHUNKED_ENCODING`；`res.end()` 是干净的流结束。
   */
  closeAll(): void {
    for (const sink of [...this.sinks]) {
      try {
        sink.end?.()
      } catch {
        // 已断开：忽略
      }
    }
    this.sinks.clear()
  }

  /** 宿主事件原样重播（impl = 上报身份 / `host`）。 */
  hostEvent(impl: string, topic: string, payload: Json): void {
    this.broadcast({ impl, topic, payload })
  }

  /** 壳状态 + 合成事件（连接态跃迁时调用）。 */
  connectionChanged(
    prevConnected: boolean,
    nextConnected: boolean,
    theme: string,
    hasDisconnected: boolean,
  ): void {
    for (const record of syntheticEventsFor(prevConnected, nextConnected, hasDisconnected)) {
      this.broadcast(record)
    }
    this.broadcast(shellStateRecord(nextConnected, theme))
  }
}
