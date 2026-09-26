// 宿主进程入口：读 options → 交组合根接线 → 暴露 HostHandle。
// 公共面只此一处；装配与效果的接线在 `composition.ts`。

import { composeHost } from './composition.ts'
import type { PortAuditRecord, PortAuditSink } from './port-audit.ts'
import type { Json } from '../kernel/index.ts'

export interface HostOptions {
  root: string
  /** 效果调用超时；缺省走 `DEFAULT_CALL_TIMEOUT_MS`（测试可注入更短值）。 */
  callTimeoutMs?: number
  /** G6 启动压缩阈值（尾段 entry 数）；缺省 `DEFAULT_COMPACT_TAIL_ENTRIES`（测试可注入小值）。 */
  compactTailEntries?: number
  /** 服务启动包装器（宿主侧最小沙箱形态）：只前置到 spawn 命令行；缺省无（零行为变化）。 */
  startWrapper?: string
  /** 端口审计落点（反向 `port.call`）：缺省写宿主侧有界内存环形缓冲。 */
  portAuditSink?: PortAuditSink
  /**
   * 源码 watcher：默认关。打开后盯 `state/plugins.json` 登记的投递路径，
   * 文件变动即自动重新入世并交装配跟随换代（开发态热更，不引入开发/生产分叉）。
   */
  watch?: boolean
  /** watcher 的终端可视线（前台模式直出终端）；缺省写宿主 stdout。 */
  watchLog?: (line: string) => void
}

export interface HostHandle {
  root: string
  socket: string
  /** 停机序列：等在途提交 → 断开客户端 → 关闭服务 → 释放锁。 */
  stop: () => Promise<void>
  /** 插件事件透传入口：只广播给已连接客户端，不落账、不推进。 */
  emitEvent: (impl: string, topic: string, payload: Json) => void
  /**
   * 端口审计只读快照（时间正序、有界）：反向 `port.call` 的宿主侧取证，
   * 不进世界、不写链、不参与重放。注入 `portAuditSink` 时仍同时写入本快照。
   */
  portAuditRecords: () => PortAuditRecord[]
}

export { MAX_DETACHED_RUNS } from './run-registry.ts'

/** 起宿主：全程阻塞在入站 socket 上，直到 stop 被调用。 */
export async function startHost(options: HostOptions): Promise<HostHandle> {
  const composed = await composeHost(options)
  return {
    root: options.root,
    socket: composed.socket,
    stop: composed.stop,
    emitEvent: composed.emitEvent,
    portAuditRecords: composed.portAuditRecords,
  }
}
