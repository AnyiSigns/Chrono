// `ui-composer` 服务进程入口：服务协议帧循环（stdio）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。浏览器侧经壳 api 按名调用宿主命令，本服务只负责
// 健康占位（`ui-composer.ping`）与客户端半边产物只读交付（`ui-composer.client.read`）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isSafeClientPath, readClientFile } from './client-read.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
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
const IDENTITY =
  typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : 'ui-composer'
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : ['ui-composer']
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

/** 客户端半边源码目录：`execute/web/`（`path` 相对此目录解析）。 */
const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))

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

let exiting = false

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

/** 本插件唯一方法：健康占位（`ui-composer.ping`）。 */
function handlePing(): Json {
  return { pong: true, identity: IDENTITY }
}

/** 只读交付客户端半边产物：参数 `{path}`，只接受包内相对 `.js` 路径。 */
function handleClientRead(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const path = args['path']
  if (!isSafeClientPath(path)) throw new BadArgsError('unsafe client path')
  const text = readClientFile(WEB_DIR, path)
  if (text === null) throw new Error('client file not found')
  return { path, text }
}

const HANDLERS: { [method: string]: (args: Json) => Json } = {
  ping: () => handlePing(),
  'client.read': (args) => handleClientRead(args),
}

function handleCall(message: Rec): void {
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
  try {
    const value = handler((args ?? null) as Json)
    sendFrame({ v: '1', id, kind: 'result', ok: true, value })
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
  setTimeout(() => process.exit(0), 10).unref?.()
}

function handle(message: Json): void {
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
      handleCall(message)
      return
    default:
      return
  }
}

const decoder = createFrameDecoder()
process.stdin.on('data', (chunk: Buffer) => {
  let messages: Json[]
  try {
    messages = decoder.push(chunk)
  } catch (err) {
    log(`bad frame: ${(err as Error).message}`)
    return
  }
  for (const message of messages) {
    try {
      handle(message)
    } catch (err) {
      log(`handle error: ${(err as Error).message}`)
    }
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)
