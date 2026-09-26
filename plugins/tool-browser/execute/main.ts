// `tool-browser` 服务入口：stdio 由 SDK 的 `runStdio` 起帧循环；inproc / worker 由宿主 import 后直调。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出，
// 并关闭全部浏览器会话（防孤儿进程）。派发保留在本插件：反向调用需回带发起 call 帧 id。

import {
  BadArgsError,
  SERVICE_PROTOCOL_VERSION,
  declaredMethods,
  deriveManifest,
  isDirectRun,
  isRecord,
  packageRootOf,
  parseCallEnv,
  readPluginJson,
  runStdio,
} from 'plugin-sdk'
import type { Json, Rec, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { loadConfig } from './config.ts'
import { describe } from './describe.ts'
import { createEngine } from './engine/factory.ts'
import { invoke } from './invoke.ts'
import { installShutdownHandlers } from './lifecycle.ts'
import { StdioPortLink, safeFailAll } from './link.ts'
import { log } from './log.ts'
import { SessionManager } from './sessions.ts'
import { ToolError } from './types.ts'

const CAPABILITY = 'tool-browser'
const CONFIG = loadConfig()
const PLUGIN = readPluginJson(packageRootOf(import.meta.url))
const MANIFEST = deriveManifest(PLUGIN, CAPABILITY, 'recomputable')
const DECLARED_METHODS = declaredMethods(MANIFEST, CAPABILITY, {
  describe: () => null,
  invoke: () => null,
})

/** 构造服务实例：会话管理 + 反向调用通道归本插件，stdio 循环由 SDK 驱动。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const emit = ctx.emit
  const link = new StdioPortLink(undefined, emit)
  const sessions = new SessionManager(createEngine, CONFIG, CONFIG.sessionIdleMs)
  let exiting = false

  function sendFrame(message: Json): void {
    if (exiting) return
    try {
      emit(message)
    } catch (err) {
      log(`write frame failed: ${(err as Error).message}`)
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
    const args = message['args']
    if (args !== undefined && args !== null && !isRecord(args)) {
      sendError(id, 'bad_args', 'args must be an object')
      return
    }
    const env = parseCallEnv(message['env'])
    let value: Json
    try {
      value = method === 'describe' ? describe() : await invoke(args ?? null, { sessions, link }, env, id)
    } catch (err) {
      if (err instanceof BadArgsError || err instanceof ToolError) {
        sendError(id, 'bad_args', err.message)
        return
      }
      log(`method ${method} failed: ${(err as Error).message}`)
      sendError(id, 'internal', 'handler failed')
      return
    }
    sendFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'result', ok: true, value })
  }

  /** 停机：关闭全部浏览器会话后退出（不泄漏进程）。 */
  function shutdown(): void {
    if (exiting) return
    exiting = true
    safeFailAll(link)
    const exit = (): void => process.exit(0)
    sessions.closeAll().then(exit, exit)
    setTimeout(exit, 5000)
  }

  // 信号 / 退出兜底：SIGTERM / SIGINT 走优雅停机，`exit` 同步硬杀残留浏览器子进程。
  installShutdownHandlers(process, {
    shutdown,
    killAllSync: () => sessions.killAllSync(),
  })

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
        log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
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

  // 串行链：会话状态有先后依赖，同一连接上的 call 按到达序处理；反向应答在 receive 内立即结算。
  let chain: Promise<void> = Promise.resolve()
  return {
    receive(message: Json): void {
      if (!isRecord(message)) return
      if (link.settle(message)) return
      chain = chain.then(() => handle(message)).catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
    },
    close(): void {
      safeFailAll(link)
      void sessions.closeAll()
    },
  }
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log })
}
