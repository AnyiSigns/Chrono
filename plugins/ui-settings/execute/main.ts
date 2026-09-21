// `ui-settings` 服务进程入口：服务协议帧循环 + 子应用 HTTP 服务 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：只读命令的投影读在入口 term，随 args 传入；
// 服务侧另持模型命令的装配 / 桥接与编排健康判定（方法表见 execute/methods.ts），
// 跨插件只经宿主反向调用（`port.call`，见 execute/port-link.ts）。

import { readFileSync } from 'node:fs'
import { Bridge } from './bridge.ts'
import { SseHub } from './events.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { startUiServer } from './http-server.ts'
import type { UiServer } from './http-server.ts'
import { InboundClient } from './inbound.ts'
import { createHandlers } from './methods.ts'
import type { CallEnv } from './methods.ts'
import { PortLink } from './port-link.ts'
import { resolvePort } from './port.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

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
const IDENTITY = typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : 'ui-settings'
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : ['ui-settings']
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

function manifest(): Rec {
  return {
    v: PROTOCOL,
    identity: IDENTITY,
    implements: IMPLEMENTS,
    methods: METHODS,
    protocol: PROTOCOL,
    state: STATE,
  }
}

const root = rootFromPluginState(process.env, process.cwd())
const sse = new SseHub()

let connected = false
let uiServer: UiServer | null = null
let exiting = false

// drain 排空：协议要求「在途结束，服务发 bye」（docs/protocol.md §2.3）。
// 调用经 stdin 串行链处理，故 drain 到达时通常已无在途；计数与等待是为显式兑现该义务。
let inFlightCalls = 0
const callIdleWaiters: (() => void)[] = []

function beginCall(): void {
  inFlightCalls += 1
}

function endCall(): void {
  inFlightCalls -= 1
  if (inFlightCalls > 0) return
  while (callIdleWaiters.length > 0) {
    const notify = callIdleWaiters.shift() as () => void
    notify()
  }
}

/** 等在途调用结束；超 `deadlineMs` 强制放行（排空期限由宿主 `restart.drain_ms` 给定）。 */
function waitForCalls(deadlineMs: number): Promise<void> {
  if (inFlightCalls === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deadlineMs)
    timer.unref?.()
    callIdleWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const inbound = new InboundClient({
  socketPath: inboundSocketPath(root),
  log,
  onEvent: (impl, topic, payload) => sse.hostEvent(impl, topic, payload),
  onFrame: (frame) => {
    const topic = typeof frame['run'] === 'string' ? 'run.result' : 'host.frame'
    sse.broadcast({ impl: IDENTITY, topic, payload: frame as unknown as Json })
  },
  onConnectionChange: (next) => {
    connected = next
    sse.broadcast({ impl: IDENTITY, topic: 'settings.state', payload: { connected } })
  },
})
const bridge = new Bridge(inbound)

function sendFrame(message: Json): void {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${(err as Error).message}`)
  }
}

function sendError(id: string, code: string, message: string): void {
  sendFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code, message })
}

// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）：模型命令的装配结果经它转发给 `model` 端口；
// 服务不读投影、不发 eff，跨插件只走宿主路由。应答帧在 stdin 帧循环里立即结算（不排队，防堵死串行链）。
const LINK = new PortLink((message) => sendFrame(message))
const HANDLERS = createHandlers({ identity: IDENTITY, model: LINK })

function declaredMethods(port: string): string[] {
  const declared = METHODS[port]
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string => typeof item === 'string')
  }
  return []
}

/** 帧 `env`：宿主填写、机械；缺失回落 `{run:null, thread:null, now:0}`（服务绝不自取时钟）。 */
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
  if (!declaredMethods(port).includes(method)) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  const args = message['args']
  if (args !== undefined && args !== null && !isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  const handler = HANDLERS[method]
  if (handler === undefined) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  beginCall()
  try {
    const value = await handler(args ?? null, parseEnv(message['env']))
    sendFrame({ v: PROTOCOL, id, kind: 'result', ok: true, value })
  } catch (err) {
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
  } finally {
    endCall()
  }
}

function shutdown(): void {
  if (exiting) return
  exiting = true
  LINK.failAll()
  inbound.close()
  const server = uiServer
  uiServer = null
  const finish = (): void => setTimeout(() => process.exit(0), 10).unref?.()
  if (server !== null) {
    void server.close().then(finish, finish)
  } else {
    finish()
  }
}

async function handle(message: Json): Promise<void> {
  if (!isRecord(message)) return
  switch (message['kind']) {
    case 'hello':
      sendFrame({ id: message['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: PROTOCOL, id: message['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'}`)
      sendFrame({ v: PROTOCOL, id: message['id'], kind: 'ack' })
      return
    case 'drain': {
      const deadlineMs = typeof message['deadline_ms'] === 'number' && message['deadline_ms'] >= 0 ? message['deadline_ms'] : 5000
      await waitForCalls(deadlineMs)
      sendFrame({ v: PROTOCOL, id: message['id'], kind: 'bye' })
      shutdown()
      return
    }
    case 'call':
      await handleCall(message)
      return
    default:
      return
  }
}

const decoder = createFrameDecoder()
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
    // 反向调用应答立即结算（不排队）：否则正在 await port.result 的 call 会把串行链堵死。
    if (isRecord(message) && LINK.settle(message)) continue
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

inbound.start()

const uiPort = resolvePort(process.env)
startUiServer(
  {
    bridge,
    sse,
    connected: () => connected,
    identity: IDENTITY,
    log,
  },
  uiPort,
).then(
  (server) => {
    uiServer = server
    log(`ui-settings listening on 127.0.0.1:${server.port} (pid ${process.pid})`)
  },
  (err: Error) => {
    log(`cannot listen on 127.0.0.1:${uiPort}: ${err.message}`)
    process.exit(1)
  },
)
