// 宿主进程入口：只解析根目录、调用超时、启动包装器与信号，其余全部交给 startHost。

import { startHost } from './host.ts'
import { appendLifecycle, flushLifecycleSync } from './lifecycle.ts'
import {
  assertNoEntryRest,
  parseEntryArgv,
  resolveCallTimeoutMs,
  resolveStartWrapper,
  resolveWatch,
} from './options.ts'
import { hostPaths, resolveRoot } from './paths.ts'

try {
  const parsed = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(parsed.root)
  // 所有启动选项（未知位置参数 / 超时 / 包装器 / watcher）按同一口径收口：非法即 fail-closed 拒启动，
  // 并记一条 host.start_failed 运维日志（不进世界、不进链），reason 取错误的规范前缀。
  const options = ((): {
    callTimeoutMs: number
    startWrapper: string | undefined
    watch: boolean
  } => {
    try {
      assertNoEntryRest(parsed.rest)
      return {
        callTimeoutMs: resolveCallTimeoutMs(
          parsed.callTimeout,
          process.env['CHRONO_CALL_TIMEOUT_MS'],
        ),
        startWrapper: resolveStartWrapper(parsed.startWrapper, process.env['CHRONO_START_WRAPPER']),
        watch: resolveWatch(parsed.watch, process.env['CHRONO_WATCH']),
      }
    } catch (err) {
      appendLifecycle(hostPaths(root).lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'start_failed',
        reason: err instanceof Error ? err.message.split(':', 1)[0] : 'bad_option',
      })
      throw err
    }
  })()
  const handle = await startHost({ root, ...options })
  process.stdout.write(
    `host listening ${handle.socket} call_timeout_ms=${options.callTimeoutMs} start_wrapper=${options.startWrapper ?? 'none'} watch=${options.watch ? 'on' : 'off'}\n`,
  )
  const shutdown = (): void => {
    void handle
      .stop()
      .then(() => {
        try {
          // 信号路径兜底：stop 已排空，这里再落稳一次，确保退出前无未写批
          flushLifecycleSync()
        } catch {
          // 退出兜底尽力而为
        }
        process.exit(0)
      })
      .catch((err: unknown) => {
        // 停机失败（如释放锁抛错）不落成未处理拒绝：先落稳日志与失败原因，再按非零码退出，避免进程挂起
        try {
          flushLifecycleSync()
        } catch {
          // 退出兜底尽力而为
        }
        process.stderr.write(`stop_failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  try {
    // 启动失败路径：进程即将退出，同步排空运维日志
    flushLifecycleSync()
  } catch {
    // 退出兜底尽力而为
  }
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
}
