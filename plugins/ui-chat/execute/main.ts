// `ui-chat` 服务进程入口：服务协议帧循环 + 子应用 HTTP 服务 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：渲染源经入站命令 `chat.history` 取回。

import { readFileSync } from 'node:fs'
import { Bridge } from './bridge.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { startUiServer } from './http-server.ts'
import type { UiServer } from './http-server.ts'
import { InboundClient } from './inbound.ts'
import { resolvePort } from './port.ts'
import { inboundSocketPath, rootFromPluginState } from './root.ts'
import { BadArgsError, isRecord } from './types.ts'
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
const IDENTITY = typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : 'ui-chat'
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : ['ui-chat']
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

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

const root = rootFromPluginState(process.env, process.cwd())

let uiServer: UiServer | null = null
let exiting = false

const inbound = new InboundClient({
  socketPath: inboundSocketPath(root),
  log,
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
  sendFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function declaredMethods(port: string): string[] {
  const declared = METHODS[port]
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string => typeof item === 'string')
  }
  return []
}

/** 本插件唯一方法：健康占位（`ui-chat.ping`）。 */
function handlePing(): { value: Json; events: { topic: string; payload: Json }[] } {
  return { value: { pong: true, identity: IDENTITY }, events: [] }
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
  try {
    const result = handlePing()
    sendFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
  }
}

function shutdown(): void {
  if (exiting) return
  exiting = true
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
    log,
  },
  uiPort,
).then(
  (server) => {
    uiServer = server
    log(`ui-chat listening on 127.0.0.1:${server.port} (pid ${process.pid})`)
  },
  (err: Error) => {
    log(`cannot listen on 127.0.0.1:${uiPort}: ${err.message}`)
    process.exit(1)
  },
)
