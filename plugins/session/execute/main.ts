// `session` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道：方法只返回写计划与事件。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { HANDLERS } from './methods.ts'
import { isRecord } from './plan.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json } from './types.ts'
import type { Rec } from './plan.ts'

const CAPABILITY = 'session'

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
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
const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[CAPABILITY])
    ? (METHODS[CAPABILITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : Object.keys(HANDLERS),
)

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

function parseEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

let eventSeq = 0

function sendEvents(events: { topic: string; payload: Json }[]): void {
  for (const event of events) {
    eventSeq += 1
    writeFrame({ v: '1', id: `session-evt-${eventSeq}`, kind: 'event', topic: event.topic, payload: event.payload })
  }
}

function sendError(id: string, code: string, message: string): void {
  writeFrame({ v: '1', id, kind: 'error', ok: false, code, message })
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
  const args = message['args']
  if (!isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  const env = parseEnv(message['env'])
  let result
  try {
    result = handler(args, env)
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  sendEvents(result.events)
  writeFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
}

function handle(message: Json): void {
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
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))

log(`service started (pid ${process.pid})`)
