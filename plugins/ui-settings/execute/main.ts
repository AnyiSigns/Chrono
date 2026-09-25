// `ui-settings` 服务进程入口：服务协议帧循环 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：只读命令的投影读在入口 term，随 args 传入；
// 服务侧另持模型命令的装配 / 桥接与编排健康判定（方法表见 execute/methods.ts），
// 跨插件只经宿主反向调用（`port.call`，见 execute/port-link.ts）。
// 客户端半边产物经 `<id>.client.read` 由本进程读回（HTTP 面已作废）。

import { readFileSync } from 'node:fs'
import { Bridge } from './bridge.ts'
import { createFrameDecoder, log, writeFrame } from './frames.ts'
import { InboundClient } from './inbound.ts'
import { createHandlers } from './methods.ts'
import type { CallEnv, SecretsChannel } from './methods.ts'
import { PortLink } from './port-link.ts'
import { DefUnavailableError } from './refs.ts'
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
// 允许脱离串行链派发的方法白名单（plugin.json `concurrent_methods`）。
const CONCURRENT = new Set(
  Array.isArray(PLUGIN['concurrent_methods'])
    ? (PLUGIN['concurrent_methods'] as Json[]).filter((item): item is string => typeof item === 'string')
    : [],
)

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
// 记忆命令经它转发给 `retrieval` / `memory-maintenance` 端口（宿主按发出者 pins 路由）；
// 服务不读投影、不发 eff，跨插件只走宿主路由。应答帧在 stdin 帧循环里立即结算（不排队，防堵死串行链）。
const LINK = new PortLink((message) => sendFrame(message))
/** 密钥本地存储面：经本进程入站连接直发 `secrets.put` / `secrets.delete`（不进世界 / 审计）。 */
const SECRETS: SecretsChannel = {
  put: async (name, value) => {
    const result = await bridge.secretsPut(name, value)
    return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message }
  },
  delete: async (name) => {
    const result = await bridge.secretsDelete(name)
    return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message }
  },
}
const HANDLERS = createHandlers({
  identity: IDENTITY,
  model: LINK,
  retrieval: LINK,
  maintenance: LINK,
  session: LINK,
  shortMemory: LINK,
  memoryStore: LINK,
  config: LINK,
  secrets: SECRETS,
  host: LINK,
})

function declaredMethods(port: string): string[] {
  const declared = METHODS[port]
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string => typeof item === 'string')
  }
  return []
}

/**
 * 该帧是否应脱离串行链派发。只有 plugin.json `concurrent_methods` 白名单里的 `call` 脱链：
 * 这些处理器全是只读（无写计划、无本地副作用），彼此与其它命令无共享可变状态，可安全并行；
 * 其余帧保持到达序串行。不能以命令 `readonly` 标记作依据——`readonly` 只描述入口 term 是否发写指令，
 * 与服务侧处理器是否无副作用 / 无写计划不是同一口径：`profile` 非 readonly 且回写 `config`，
 * `secret` 标了 readonly 却有本地写副作用，二者脱链都会与写路径竞态。
 */
function isConcurrentCall(message: Json): boolean {
  if (!isRecord(message) || message['kind'] !== 'call') return false
  const method = message['method']
  return typeof method === 'string' && CONCURRENT.has(method)
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
    if (err instanceof DefUnavailableError) {
      sendError(id, 'def_unavailable', err.message)
      return
    }
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
  setTimeout(() => process.exit(0), 10).unref?.()
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
    // 只读方法脱链派发：其反向调用可能长时间挂起（模型 / 记忆后端），若占着串行链会让其余命令全部排队、
    // 直至壳的入站桥超时。脱链调用仍走 handleCall，故 beginCall / endCall 照常计数，drain 仍会等它们收口。
    if (isConcurrentCall(message)) {
      void handle(message).catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
      continue
    }
    chain = chain
      .then(() => handle(message))
      .catch((err: unknown) => log(`handle error: ${(err as Error).message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

inbound.start()
log(`ui-settings service ready (pid ${process.pid})`)
