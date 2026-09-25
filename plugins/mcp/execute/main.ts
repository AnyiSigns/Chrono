// `mcp` 服务进程入口：宿主服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出，并终止全部外部 MCP 子进程（防孤儿）。
// 服务不读投影、无写通道：方法只返回值 / 写计划与事件。

import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers, REGISTRY, SECRETS } from './methods.ts'
import { IDENTITY, IMPLEMENTS, METHODS, PROTOCOL, STATE } from './plugin.ts'
import { isRecord } from './plan.ts'
import { McpStore } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

/** 清单自有持久存储（④ `CHRONO_PLUGIN_DATA`）；进程内单例。 */
const STORE = McpStore.open()
const HANDLERS = createHandlers({ store: STORE })

const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[IDENTITY])
    ? (METHODS[IDENTITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : Object.keys(HANDLERS),
)

let exiting = false

function manifest(): Rec {
  return {
    v: '1',
    identity: IDENTITY,
    implements: IMPLEMENTS,
    methods: METHODS,
    protocol: PROTOCOL,
    state: STATE,
  }
}

function sendFrame(message: Json): void {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${(err as Error).message}`)
  }
}

function sendError(id: string, code: string, message: string): void {
  sendFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function parseEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

async function handleCall(message: Rec): Promise<void> {
  const id = typeof message['id'] === 'string' ? (message['id'] as string) : ''
  const port = message['port']
  const method = message['method']
  if (typeof port !== 'string' || typeof method !== 'string') {
    sendError(id, 'bad_args', 'port and method must be strings')
    return
  }
  if (!IMPLEMENTS.includes(port)) {
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
  const args = message['args']
  if (args !== undefined && args !== null && !isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  const env = parseEnv(message['env'])
  let result
  try {
    result = await handler(args ?? null, env, id)
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  sendFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
}

/** 停机：终止全部外部子进程，然后退出（等在途建连落地 + 关闭完成再退）。 */
function shutdown(): void {
  if (exiting) return
  exiting = true
  try {
    SECRETS.failAll()
  } catch (err) {
    log(`secrets failAll failed: ${(err as Error).message}`)
  }
  const exit = (): void => process.exit(0)
  REGISTRY.closeAll().then(exit, exit)
  // 兜底：关闭卡住时也强制退出（不阻断停机）。
  setTimeout(exit, 5000)
}

// 信号 / 退出兜底：SIGTERM / SIGINT 走优雅停机（SIGKILL 到点强杀），
// `exit` 同步硬杀残留外部子进程（覆盖 process.exit 与硬杀路径，不泄漏进程）。
process.on('SIGTERM', () => {
  log('received SIGTERM; shutting down')
  shutdown()
})
process.on('SIGINT', () => {
  log('received SIGINT; shutting down')
  shutdown()
})
process.on('exit', () => REGISTRY.killAllSync())

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
  switch (message['kind']) {
    case 'hello':
      sendFrame({ id: message['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: '1', id: message['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
      sendFrame({ v: '1', id: message['id'], kind: 'ack' })
      return
    case 'drain':
      sendFrame({ v: '1', id: message['id'], kind: 'bye' })
      shutdown()
      return
    case 'call':
      await handleCall(message)
      return
    default:
      return
  }
}

const decoder = createFrameDecoder()
// 串行链：保证同一连接上的消息按到达序处理（discover 未完成前不开始下一条 call）。
let chain: Promise<void> = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  let messages: Json[]
  try {
    messages = decoder.push(chunk)
  } catch (err) {
    log(`bad frame: ${(err as Error).message}`)
    return
  }
  for (const message of messages) {
    // 反向调用应答立即结算（不排队）：否则正在 await port.result 的 call 会把链堵死。
    if (isRecord(message) && SECRETS.settle(message)) continue
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

log(`service started (pid ${process.pid})`)
