// 运维日志：宿主生命周期事件的唯一落点。
// 内存缓冲 + 有界延迟批量追加：同一文件保持单个 append 句柄，按批写入、按批 fsync。
// 逐行原子追加；不进世界、不进链、不参与重放。

import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'
import { writeAllSync } from './common/fs-atomic.ts'

/** 运维日志事件的两级命名：`kind` 封闭、`event` 每 kind 有规范表（见 `docs/host.md` §五 其它）。 */
export type LifecycleKind = 'host' | 'dep' | 'handshake' | 'service'

/** 一条运维日志记录；`at` 必有，其余按事件取用；`seq` 仅换代类事件可选携带。 */
export interface LifecycleRecord {
  at: number
  kind: LifecycleKind
  event: string
  impl?: string
  gen?: string
  cap?: string
  reason?: string
  caps?: string[]
  seq?: number
  /** run 生命周期异常（如 `run_failed`）标注的宿主 run id。 */
  run?: string
}

/** 记一条事件时调用方给出的字段：`at` / `kind` / `event` 由落点补齐。 */
export type LifecycleFields = Omit<LifecycleRecord, 'at' | 'kind' | 'event'>

/** 批量落盘的定时窗口上界（ms）：事件再多也至多等这么久，落盘延迟有界。 */
export const LIFECYCLE_FLUSH_INTERVAL_MS = 100

/** 单批待写字节阈值：累计达到即立即落盘，避免大突发在内存滞留。 */
export const LIFECYCLE_FLUSH_BYTES = 64 * 1024

/** 每个日志文件一个落点：单个 append 句柄 + 待写行缓冲。 */
interface LifecycleSink {
  file: string
  dirReady: boolean
  fd: number | undefined
  lines: string[]
  bytes: number
  timer: NodeJS.Timeout | undefined
}

const sinks = new Map<string, LifecycleSink>()
let fsyncOnFlush = false
let exitHooked = false

/**
 * 每批 flush 后是否 fsync：缺省关，依赖 OS 页缓存（进程崩溃不丢已 flush 数据）；
 * 仅在需要抗掉电 / 掉 OS 时打开。停机 / 致命路径始终强制 fsync，与开关无关。
 */
export function setLifecycleFsync(enabled: boolean): void {
  fsyncOnFlush = enabled
}

function sinkFor(file: string): LifecycleSink {
  const key = resolve(file)
  let sink = sinks.get(key)
  if (sink === undefined) {
    sink = { file: key, dirReady: false, fd: undefined, lines: [], bytes: 0, timer: undefined }
    sinks.set(key, sink)
  }
  return sink
}

/** 首次落盘才建目录 / 开句柄：mkdir 只做一次，句柄跨批复用。 */
function openSink(sink: LifecycleSink): number {
  if (!sink.dirReady) {
    mkdirSync(dirname(sink.file), { recursive: true })
    sink.dirReady = true
  }
  if (sink.fd === undefined) sink.fd = openSync(sink.file, 'a')
  return sink.fd
}

/** 写出待写缓冲；`forceFsync` 用于停机 / 致命等要求落稳的路径。 */
function flushSink(sink: LifecycleSink, forceFsync = false): void {
  if (sink.timer !== undefined) {
    clearTimeout(sink.timer)
    sink.timer = undefined
  }
  if (sink.lines.length === 0) return
  const payload = sink.lines.join('')
  sink.lines.length = 0
  sink.bytes = 0
  const fd = openSink(sink)
  writeAllSync(fd, payload)
  if (forceFsync || fsyncOnFlush) fsyncSync(fd)
}

function closeSink(sink: LifecycleSink): void {
  if (sink.timer !== undefined) {
    clearTimeout(sink.timer)
    sink.timer = undefined
  }
  if (sink.fd !== undefined) {
    closeSync(sink.fd)
    sink.fd = undefined
  }
}

/** 定时窗口到期落盘；句柄保持打开，后续批继续复用。 */
function scheduleFlush(sink: LifecycleSink): void {
  if (sink.timer !== undefined) return
  sink.timer = setTimeout(() => {
    sink.timer = undefined
    try {
      flushSink(sink)
    } catch {
      // 定时器内落盘失败不得抛成未捕获异常；该批只损失可观测性
    }
  }, LIFECYCLE_FLUSH_INTERVAL_MS)
  sink.timer.unref()
}

/** 进程退出兜底：同步排空并关闭，避免未到期批随进程消失。 */
function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const sink of sinks.values()) {
      try {
        flushSink(sink, true)
        closeSink(sink)
      } catch {
        // 退出兜底尽力而为，绝不因日志写失败改变退出码
      }
    }
  })
}

/** 追加一条生命周期事件；文件不存在则连同父目录一起创建。 */
export function appendLifecycle(file: string, event: Json): void {
  const sink = sinkFor(file)
  const line = canonicalJson(event) + '\n'
  sink.lines.push(line)
  sink.bytes += line.length
  hookExit()
  if (sink.bytes >= LIFECYCLE_FLUSH_BYTES) {
    flushSink(sink)
    return
  }
  scheduleFlush(sink)
}

/** 立即写出待写缓冲（不强制 fsync）；缺省 flush 全部落点。 */
export function flushLifecycle(file?: string): void {
  if (file === undefined) {
    for (const sink of sinks.values()) flushSink(sink)
    return
  }
  const sink = sinks.get(resolve(file))
  if (sink !== undefined) flushSink(sink)
}

/** 停机 / 致命路径：同步排空、强制 fsync 并关闭句柄，确保进程退出前事件不丢。 */
export function flushLifecycleSync(file?: string): void {
  const targets =
    file === undefined
      ? [...sinks.values()]
      : [sinks.get(resolve(file))].filter((sink): sink is LifecycleSink => sink !== undefined)
  for (const sink of targets) {
    flushSink(sink, true)
    closeSink(sink)
  }
}
