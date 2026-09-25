// `storage-sql` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道、无 pins（不发反向调用）：
// 命名空间取帧 `env.emitter`，数据落 CHRONO_PLUGIN_DATA 下的按 owner 分库 SQLite。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers } from './methods.ts'
import { SqlEngine } from './engine.ts'
import { BadArgsError, StoreError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

const CAPABILITY = 'storage-sql'

const ENGINE = new SqlEngine(process.env['CHRONO_PLUGIN_DATA'] ?? null)
const HANDLERS = createHandlers(ENGINE)

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Rec
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
const METHODS = typeof PLUGIN['methods'] === 'object' && PLUGIN['methods'] !== null && !Array.isArray(PLUGIN['methods'])
  ? (PLUGIN['methods'] as Rec)
  : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'
const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[CAPABILITY])
    ? (METHODS[CAPABILITY] as Json[]).filter((item): item is string => typeof item === 'string')
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { run: null, thread: null, now: 0, emitter: null }
  }
  const env = raw as Rec
  return {
    run: typeof env['run'] === 'string' ? env['run'] : null,
    thread: typeof env['thread'] === 'string' ? env['thread'] : null,
    now: typeof env['now'] === 'number' && Number.isFinite(env['now']) ? env['now'] : 0,
    emitter: typeof env['emitter'] === 'string' && env['emitter'].length > 0 ? env['emitter'] : null,
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
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
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
    if (err instanceof StoreError) {
      sendError(id, err.code, err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  sendFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
}

async function handle(message: Json): Promise<void> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  const rec = message as Rec
  switch (rec['kind']) {
    case 'hello':
      sendFrame({ id: rec['id'], kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: '1', id: rec['id'], kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof rec['gen'] === 'string' ? rec['gen'] : '?'}`)
      sendFrame({ v: '1', id: rec['id'], kind: 'ack' })
      return
    case 'drain':
      sendFrame({ v: '1', id: rec['id'], kind: 'bye' })
      shutdown()
      return
    case 'call':
      await handleCall(rec)
      return
    default:
      return
  }
}

function shutdown(): void {
  if (exiting) return
  exiting = true
  ENGINE.close()
  setTimeout(() => process.exit(0), 10).unref?.()
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

log(`service started (pid ${process.pid})`)
