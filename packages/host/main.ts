// 宿主进程入口：只解析根目录、调用超时、启动包装器与信号，其余全部交给 startHost。

import { startHost } from './host.ts'
import { appendLifecycle, flushLifecycleSync } from './lifecycle.ts'
import {
  parseEntryArgv,
  resolveCallTimeoutMs,
  resolveStartWrapper,
  resolveWatch,
} from './options.ts'
import { hostPaths, resolveRoot } from './paths.ts'

try {
  const parsed = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(parsed.root)
  const callTimeoutMs = resolveCallTimeoutMs(
    parsed.callTimeout,
    process.env['CHRONO_CALL_TIMEOUT_MS'],
  )
  let startWrapper: string | undefined
  try {
    startWrapper = resolveStartWrapper(parsed.startWrapper, process.env['CHRONO_START_WRAPPER'])
  } catch (err) {
    // 包装器非法：fail-closed 拒启动，并留一条运维日志（不进世界、不进链）
    appendLifecycle(hostPaths(root).lifecycleFile, {
      at: Date.now(),
      kind: 'host',
      event: 'start_failed',
      reason: 'bad_start_wrapper',
    })
    throw err
  }
  const watch = resolveWatch(parsed.watch, process.env['CHRONO_WATCH'])
  const handle = await startHost({ root, callTimeoutMs, startWrapper, watch })
  process.stdout.write(
    `host listening ${handle.socket} call_timeout_ms=${callTimeoutMs} start_wrapper=${startWrapper ?? 'none'} watch=${watch ? 'on' : 'off'}\n`,
  )
  const shutdown = (): void => {
    void handle.stop().then(() => {
      try {
        // 信号路径兜底：stop 已排空，这里再落稳一次，确保退出前无未写批
        flushLifecycleSync()
      } catch {
        // 退出兜底尽力而为
      }
      process.exit(0)
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
