// `mcp-client` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 本进程持有全部外部 MCP 子进程：SIGTERM / SIGINT 走优雅停机（宽限后 SIGKILL），
// `exit` 同步硬杀兜底（覆盖 process.exit 与硬杀路径，不泄漏孤儿）。服务不读投影、无写通道。

import { defineService, makeLogger } from 'plugin-sdk'
import { emitEvent } from './events.ts'
import { createHandlers } from './methods.ts'
import { McpClientRegistry } from './registry.ts'

const LOG = makeLogger('mcp-client')

/** 当前服务实例的连接注册表；信号 / 退出兜底据此终止全部外部子进程。 */
let registry: McpClientRegistry | null = null

/** 停机：终止全部外部子进程；返回 closeAll 落地 promise，drain 时 SDK 等它完成再退出。 */
function shutdown(): Promise<void> {
  const active = registry
  if (active === null) return Promise.resolve()
  return active
    .closeAll()
    .catch((err) => LOG(`registry closeAll failed: ${(err as Error).message}`))
}

// 信号 / 退出兜底：SIGTERM / SIGINT 走优雅停机（SIGKILL 到点强杀），
// `exit` 同步硬杀残留外部子进程（覆盖 process.exit 与硬杀路径，不泄漏进程）。
process.on('SIGTERM', () => {
  LOG('received SIGTERM; shutting down')
  void shutdown()
})
process.on('SIGINT', () => {
  LOG('received SIGINT; shutting down')
  void shutdown()
})
process.on('exit', () => registry?.killAllSync())

export const createService = defineService({
  entry: import.meta.url,
  capability: 'mcp-client',
  logPrefix: 'mcp-client',
  log: LOG,
  setup: () => {
    const active = new McpClientRegistry(LOG, emitEvent)
    registry = active
    return {
      handlers: createHandlers({ registry: active }),
      onDrain: shutdown,
      onClose: shutdown,
    }
  },
})
