// `mcp` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出，
// 并终止全部外部 MCP 子进程（防孤儿）。服务不读投影、无写通道：方法只返回值 / 写计划与事件。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers, REGISTRY, SECRETS } from './methods.ts'
import { isRecord } from './plan.ts'
import { McpStore } from './store.ts'
import type { Handler, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'mcp'
const LOG = makeLogger('mcp')

/** 停机：未结算的反向调用作数据失败 + 终止全部外部子进程（进程 exit 时同步兜底）。 */
function shutdown(): void {
  try {
    SECRETS.failAll()
  } catch (err) {
    LOG(`secrets failAll failed: ${(err as Error).message}`)
  }
  REGISTRY.closeAll().catch((err) => LOG(`registry closeAll failed: ${(err as Error).message}`))
}

// 信号 / 退出兜底：SIGTERM / SIGINT 走优雅停机（SIGKILL 到点强杀），
// `exit` 同步硬杀残留外部子进程（覆盖 process.exit 与硬杀路径，不泄漏进程）。
process.on('SIGTERM', () => {
  LOG('received SIGTERM; shutting down')
  shutdown()
})
process.on('SIGINT', () => {
  LOG('received SIGINT; shutting down')
  shutdown()
})
process.on('exit', () => REGISTRY.killAllSync())

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const handlers = createHandlers({ store: McpStore.open(ctx.env) })
  // 发起 call 帧 id 按 args 对象登记：SDK 派发器把同一 args 引用交给处理器，故可回带 `call_id`。
  const callIds = new WeakMap<object, string>()
  const sdkHandlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    sdkHandlers[method] = async (args, env) => {
      const callId = isRecord(args) ? callIds.get(args) ?? null : null
      const result = await handler(args, env, callId)
      return { value: result.value, events: [] }
    }
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: sdkHandlers,
    emit: ctx.emit,
    log: LOG,
    intercept: (message: Rec) => {
      if (message['kind'] === 'call' && isRecord(message['args']) && typeof message['id'] === 'string') {
        callIds.set(message['args'], message['id'])
      }
      return SECRETS.settle(message)
    },
    onDrain: shutdown,
    onClose: shutdown,
    drainExitMs: 10,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
