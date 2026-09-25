// `skill` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。技能清单已出世界：写即时落自有持久存储（④），读从自有存储取。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { createHandlers } from './methods.ts'
import { isRecord } from './plan.ts'
import { SkillStore } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

const CAPABILITY = 'skill'

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

const HANDLERS = createHandlers({ store: SkillStore.open() })

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
  let result
  try {
    result = await handler(args ?? null, parseEnv(message['env']))
  } catch (err) {
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
      return
    }
    log(`method ${method} failed: ${(err as Error).message}`)
    sendError(id, 'internal', 'handler failed')
    return
  }
  writeFrame({ v: '1', id, kind: 'result', ok: true, value: result.value })
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
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))

log(`service started (pid ${process.pid})`)
