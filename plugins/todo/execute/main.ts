// `todo` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。清单本体已出世界：写即时落委托存储（storage-kv），读从自有存储取。
// 反向调用（storage-kv.*）走 `port.call`，应答帧立即结算（不排队）。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers } from './methods.ts'
import { PortLink, RemoteStorage } from './port-link.ts'
import { TodoStore } from './store.ts'
import { isRecord } from './plan.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

const CAPABILITY = 'todo'

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${(err as Error).message}`)
  }
  return {}
}

const PLUGIN = readPlugin()
const IDENTITY = typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : CAPABILITY
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : [CAPABILITY]
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

const LINK = new PortLink((message) => writeFrame(message))
const HANDLERS = createHandlers({ store: new TodoStore(new RemoteStorage(LINK)) })

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

function sendError(id: string, code: string, message: string): void {
  writeFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function parseEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

/** 声明的某端口方法集（从 plugin.json.methods 机械读；缺声明时回落处理器表）。 */
function declaredMethods(port: string): string[] {
  const declared = METHODS[port]
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string => typeof item === 'string')
  }
  return Object.keys(HANDLERS)
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
  if (!declaredMethods(port).includes(method)) {
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
    result = await handler(args ?? null, env)
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    if (err instanceof ToolError) {
      sendError(id, err.code, err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  writeFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
}

/** 停机：未结算的反向调用作数据失败，然后退出。 */
function shutdown(): void {
  LINK.failAll()
  setTimeout(() => process.exit(0), 10).unref?.()
}

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
  switch (message['kind']) {
    case 'hello':
      writeFrame({ id: message['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      writeFrame({ v: '1', id: message['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
      writeFrame({ v: '1', id: message['id'], kind: 'ack' })
      return
    case 'drain':
      writeFrame({ v: '1', id: message['id'], kind: 'bye' })
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
// 串行链：保证同一连接上的消息按到达序处理；反向调用应答立即结算（不排队），
// 否则正在 await port.result 的 call 会把链堵死。
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
    if (isRecord(message) && LINK.settle(message)) continue
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

log(`service started (pid ${process.pid})`)
