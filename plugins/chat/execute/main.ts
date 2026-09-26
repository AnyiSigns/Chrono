// `chat` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 回合管道经反向调用 `port.call loop-policy.interpret`（title 旁路段 `session-title.generate`）。
// 只读方法走独立派发器：长回合 `send` 挂起时读命令仍可并发，不被串行链阻塞。

import { PortLink, createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { READONLY_METHODS } from './plugin.ts'
import { isRecord } from './plan.ts'
import { loadWiring } from './wiring.ts'
import type { Handler, Json, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'chat'
const LOG = makeLogger('chat')
/** 反向调用等待上限：须 ≥ `loop-policy.interpret` 的声明超时（包住多次模型调用）。 */
const PORT_CALL_TIMEOUT_MS = 600000

/** 只读 call 判定：kind=call 且 method 由声明派生为只读。 */
function isReadonlyCall(message: Json): boolean {
  if (!isRecord(message) || message['kind'] !== 'call') return false
  const method = message['method']
  return typeof method === 'string' && READONLY_METHODS.has(method)
}

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'chat', timeoutMs: PORT_CALL_TIMEOUT_MS })
  const handlers = createHandlers({ port: link, host: link, wiring: loadWiring() })
  const sdkHandlers: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    sdkHandlers[method] = async (args, env) => ({ value: await handler(args, env), events: [] })
  }
  const common = {
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: sdkHandlers,
    emit: ctx.emit,
    log: LOG,
    intercept: (message: Rec) => link.settle(message),
  }
  const normal = createSdkService({
    ...common,
    onDrain: () => link.failAll(),
    onClose: () => link.failAll(),
    drainExitMs: 10,
  })
  const readonly = createSdkService({ ...common, eventIdPrefix: 'chat-readonly-evt' })
  return {
    receive(message: Json): void {
      if (isReadonlyCall(message)) readonly.receive(message)
      else normal.receive(message)
    },
    close(): void {
      normal.close()
      readonly.close()
    },
  }
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
