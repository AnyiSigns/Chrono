// 宿主进程入口：只解析根目录、调用超时与信号，其余全部交给 startHost。

import { startHost } from './host.ts'
import { parseEntryArgv, resolveCallTimeoutMs } from './options.ts'
import { resolveRoot } from './paths.ts'

try {
  const parsed = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(parsed.root)
  const callTimeoutMs = resolveCallTimeoutMs(
    parsed.callTimeout,
    process.env['CHRONO_CALL_TIMEOUT_MS'],
  )
  const handle = await startHost({ root, callTimeoutMs })
  process.stdout.write(`host listening ${handle.socket} call_timeout_ms=${callTimeoutMs}\n`)
  const shutdown = (): void => {
    void handle.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
}
