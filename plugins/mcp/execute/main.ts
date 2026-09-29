// `mcp` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 出站连接 / 子进程生命周期不在本进程：经反向 `port.call mcp-client.*` 委派给 `mcp-client` 提供方；
// 本进程只保留清单存储与失败 / 隔离 / 重启策略。服务不读投影、无写通道：方法只返回值 / 写计划与事件。

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
import { RemoteMcpClient } from './port-link.ts'
import { McpRegistry } from './registry.ts'
import type { SecretResult } from './registry.ts'
import { McpStore } from './store.ts'

const CAPABILITY = 'mcp'
const LOG = makeLogger('mcp')

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
  const link = new PortLink({ write: ctx.emit, idPrefix: 'mcp' })
  const registry = new McpRegistry(LOG, emitEvent, new RemoteMcpClient(link), (authRef, callId) =>
    resolveSecret(link, authRef, callId),
  )
  const handlers = createHandlers({ store: McpStore.open(ctx.env), registry })
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
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
