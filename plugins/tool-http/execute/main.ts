// `tool-http` 服务入口：stdio 由 SDK 的 `runStdio` 起帧循环；inproc / worker 由宿主 import 后直调。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 派发保留在本插件：反向调用需回带发起 call 帧 id，SDK 派发器不向处理器传 callId。

import {
  BadArgsError,
  SERVICE_PROTOCOL_VERSION,
  declaredMethods,
  deriveManifest,
  isDirectRun,
  isRecord,
  makeLogger,
  packageRootOf,
  parseCallEnv,
  readPluginJson,
  runStdio,
} from 'plugin-sdk'
import type { Json, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { HANDLERS, REVERSE } from './methods.ts'

const CAPABILITY = 'tool-http'
const LOG = makeLogger('tool-http')
const PLUGIN = readPluginJson(packageRootOf(import.meta.url))
const MANIFEST = deriveManifest(PLUGIN, CAPABILITY, 'recomputable')
const DECLARED_METHODS = declaredMethods(MANIFEST, CAPABILITY, HANDLERS)

/** 构造服务实例：帧派发由本插件提供（反向调用需 call 帧 id），stdio 循环由 SDK 驱动。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const emit = ctx.emit
  let exiting = false

  function sendFrame(message: Json): void {
    if (exiting) return
    try {
      emit(message)
    } catch (err) {
      LOG(`write frame failed: ${(err as Error).message}`)
    }
  }

  function sendError(id: string, code: string, message: string): void {
    sendFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'error', ok: false, code, message })
  }

  async function handleCall(message: Rec): Promise<void> {
    const id = typeof message['id'] === 'string' ? (message['id'] as string) : ''
    const port = message['port']
    const method = message['method']
    if (typeof port !== 'string' || typeof method !== 'string') {
      sendError(id, 'bad_args', 'port and method must be strings')
      return
    }
    if (!MANIFEST.implements.includes(port)) {
      sendError(id, 'unresolved_cap', `unknown capability ${port}`)
      return
    }
    if (!DECLARED_METHODS.has(method)) {
      sendError(id, 'unknown_method', `unknown method ${method}`)
      return
    }
    const handler = HANDLERS[method]
    if (handler === undefined) {
      sendError(id, 'unknown_method', `unknown method ${method}`)
      return
    }
    const raw = message['args']
    const args = raw === undefined || raw === null ? {} : raw
    if (!isRecord(args)) {
      sendError(id, 'bad_args', 'args must be an object')
      return
    }
    let value: Json
    try {
      value = await handler(args, parseCallEnv(message['env']), id)
    } catch (err) {
      if (err instanceof BadArgsError) {
        sendError(id, 'bad_args', err.message)
        return
      }
      LOG(`method ${method} failed: ${(err as Error).message}`)
      sendError(id, 'internal', 'handler failed')
      return
    }
    sendFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'result', ok: true, value })
  }

  function shutdown(): void {
    if (exiting) return
    exiting = true
    try {
      REVERSE.failAll()
    } catch (err) {
      LOG(`reverse failAll failed: ${(err as Error).message}`)
    }
    setTimeout(() => process.exit(0), 10).unref?.()
  }

  async function handle(message: Json): Promise<void> {
    if (!isRecord(message)) return
    switch (message['kind']) {
      case 'hello':
        sendFrame({ id: message['id'], kind: 'manifest', ...MANIFEST })
        return
      case 'probe':
        sendFrame({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'pong', ok: true })
        return
      case 'reload':
        LOG(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
        sendFrame({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'ack' })
        return
      case 'drain':
        sendFrame({ v: SERVICE_PROTOCOL_VERSION, id: message['id'], kind: 'bye' })
        shutdown()
        return
      case 'call':
        await handleCall(message)
        return
      default:
        return
    }
  }

  // 串行链：同一连接上的消息按到达序处理；反向应答在 receive 内立即结算（不排队）。
  let chain: Promise<void> = Promise.resolve()
  return {
    receive(message: Json): void {
      if (!isRecord(message)) return
      if (REVERSE.settle(message)) return
      chain = chain
        .then(() => handle(message))
        .catch((err: unknown) => LOG(`handle error: ${(err as Error).message}`))
    },
    close(): void {
      try {
        REVERSE.failAll()
      } catch (err) {
        LOG(`reverse failAll failed: ${(err as Error).message}`)
      }
    },
  }
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
