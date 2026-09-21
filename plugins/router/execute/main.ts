// `router` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道、不取时间 / 随机——select 同输入同输出。

import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { HANDLERS } from './methods.ts'
import {
  IDENTITY,
  IMPLEMENTS,
  METHODS,
  PROTOCOL,
  STATE,
} from './plugin.ts'
import { BadArgsError } from './types.ts'
import type { Json, Rec } from './types.ts'

const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[IDENTITY])
    ? (METHODS[IDENTITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : Object.keys(HANDLERS),
)

let exiting = false

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    value = handler(args)
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  sendFrame({ v: '1', id, kind: 'result', ok: true, value })
}

/** 停机：先让协议帧写完再退出。 */
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

log(`service started (pid ${process.pid})`)
