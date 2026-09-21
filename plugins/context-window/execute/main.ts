// `context-window` 服务进程入口：服务协议帧循环（docs/protocol.md §二）。
// 启动即加载原生 tokenizer 与 policy：任一失败 ⇒ 在 hello 前退出非 0（宿主隔离，绝不回落 JS 计数）。
// manifest 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { handleBuild, assertBag } from './methods.ts'
import { loadTokenizer, nativeLoadedFrom, tokenizerVersion } from './native.ts'
import { loadPolicy } from './policy.ts'
import { isRecord } from './text.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Policy } from './types.ts'

const CAPABILITY = 'context'

function readPlugin(): Record<string, unknown> {
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
const METHODS = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Record<string, Json>) : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'
const DECLARED_METHODS = new Set<string>(
  Array.isArray(METHODS[CAPABILITY])
    ? (METHODS[CAPABILITY] as Json[]).filter((item): item is string => typeof item === 'string')
    : ['build'],
)

// 原生 tokenizer：唯一实现，加载失败即服务启动失败（在 hello 前退出非 0）。
try {
  loadTokenizer()
} catch (err) {
  log(`native tokenizer load failed: ${(err as Error).message}`)
  process.exit(1)
}

let currentPolicy: Policy
try {
  currentPolicy = loadPolicy()
} catch (err) {
  log(`policy load failed: ${(err as Error).message}`)
  process.exit(1)
}

function manifest(): Record<string, Json> {
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
    writeFrame({ v: '1', id: `ctx-evt-${eventSeq}`, kind: 'event', topic: event.topic, payload: event.payload })
  }
}

function sendError(id: string, code: string, message: string): void {
  writeFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function handleCall(message: Record<string, unknown>): void {
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
  if (!DECLARED_METHODS.has(method) || method !== 'build') {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  let result
  try {
    assertBag(message['args'])
    result = handleBuild(message['args'], parseEnv(message['env']), currentPolicy)
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
      try {
        currentPolicy = loadPolicy()
        log(`reload gen=${typeof message['gen'] === 'string' ? message['gen'] : '?'} policy reloaded`)
      } catch (err) {
        log(`reload policy failed, keeping current: ${(err as Error).message}`)
      }
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
    // 协议损坏（坏 JSON / 超长帧）即退出：与原生服务同口径，让宿主按 fail-closed 隔离该服务，
    // 不留在坏缓冲区上反复抛错。
    log(`bad frame: ${(err as Error).message}`)
    process.exit(1)
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

log(
  `service started (pid ${process.pid}); tokenizer=${tokenizerVersion()} from ${nativeLoadedFrom() ?? '?'}`,
)
