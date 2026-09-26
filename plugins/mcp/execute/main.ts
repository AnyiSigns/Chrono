// `mcp` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出，
// 并终止全部外部 MCP 子进程（防孤儿）。服务不读投影、无写通道：方法只返回值 / 写计划与事件。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Handler, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { emitEvent } from './events.ts'
import { createHandlers } from './methods.ts'
import { McpRegistry } from './registry.ts'
import type { SecretResult } from './registry.ts'
import { McpStore } from './store.ts'

const CAPABILITY = 'mcp'
const LOG = makeLogger('mcp')

/** 当前服务实例的子进程注册表；信号 / 退出兜底据此终止全部外部子进程。 */
let registry: McpRegistry | null = null

/** 停机：终止全部外部子进程；返回 closeAll 落地 promise，drain 时 SDK 等它完成再退出。 */
function shutdown(): Promise<void> {
  const active = registry
  if (active === null) return Promise.resolve()
  return active.closeAll().catch((err) => LOG(`registry closeAll failed: ${(err as Error).message}`))
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

/** `secrets.resolve` 适配：把 SDK 反向结果映射成注册表要的结构化结果。 */
async function resolveSecret(
  link: PortLink,
  authRef: Rec,
  callId: string | null,
): Promise<SecretResult> {
  const outcome = await link.call('secrets', 'resolve', { auth_ref: authRef }, { callId })
  if (!outcome.ok) return outcome
  if (typeof outcome.value !== 'string' || outcome.value.length === 0) {
    return { ok: false, code: 'secret_missing', message: 'secrets.resolve returned no value' }
  }
  return { ok: true, value: outcome.value }
}

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const secrets = new PortLink({ write: ctx.emit, idPrefix: 'mcp' })
  const active = new McpRegistry(LOG, emitEvent, (authRef, callId) =>
    resolveSecret(secrets, authRef, callId),
  )
  registry = active
  const handlers = createHandlers({ store: McpStore.open(ctx.env), registry: active })
  const sdkHandlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    sdkHandlers[method] = async (args, env, call) => {
      const result = await handler(args, env, call.callId)
      return { value: result.value, events: [] }
    }
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: sdkHandlers,
    emit: ctx.emit,
    log: LOG,
    portLinks: [secrets],
    onDrain: shutdown,
    onClose: shutdown,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
