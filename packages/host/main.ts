// 宿主进程入口：只解析根目录与信号，其余全部交给 startHost。

import { startHost } from './host.ts'
import { resolveRoot } from './paths.ts'

function readRoot(argv: string[]): string | undefined {
  const index = argv.indexOf('--root')
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

try {
  const handle = await startHost({ root: resolveRoot(readRoot(process.argv.slice(2))) })
  process.stdout.write(`host listening ${handle.socket}\n`)
  const shutdown = (): void => {
    void handle.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
}
