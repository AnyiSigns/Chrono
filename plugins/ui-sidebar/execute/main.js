// `ui-sidebar` 服务进程入口：服务协议帧循环 + 自实现入站客户端。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：入口 term 把 `ctx.ids` 随 args 传入，
// 服务装配后经宿主反向调用（`port.call`）转给 `session` / `workspace`（见 execute/methods.js）。
// 客户端半边改由插件自交付（`ui-sidebar.client.read` 读包内产物），本服务不再开 HTTP 面。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.js'
import { InboundClient } from './inbound.js'
import { createHandlers } from './methods.js'
import { PortLink } from './port-link.js'
import { inboundSocketPath, rootFromPluginState } from './root.js'
import { BadArgsError, isRecord } from './types.js'

function readPlugin() {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${err.message}`)
  }
  return {}
}

const PLUGIN = readPlugin()
const IDENTITY = typeof PLUGIN['identity'] === 'string' ? PLUGIN['identity'] : 'ui-sidebar'
const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? PLUGIN['implements'].filter((item) => typeof item === 'string')
  : ['ui-sidebar']
const METHODS = isRecord(PLUGIN['methods']) ? PLUGIN['methods'] : {}
const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? PLUGIN['protocol'] : '1'
const STATE = typeof PLUGIN['state'] === 'string' ? PLUGIN['state'] : 'recomputable'

function manifest() {
  return { v: PROTOCOL, identity: IDENTITY, implements: IMPLEMENTS, methods: METHODS, protocol: PROTOCOL, state: STATE }
}

const root = rootFromPluginState(process.env, process.cwd())

let exiting = false

// drain 排空：协议要求「在途结束，服务发 bye」；调用经 stdin 串行链处理，计数与等待显式兑现该义务。
let inFlightCalls = 0
const callIdleWaiters = []

function beginCall() {
  inFlightCalls += 1
}

function endCall() {
  inFlightCalls -= 1
  if (inFlightCalls > 0) return
  while (callIdleWaiters.length > 0) {
    const notify = callIdleWaiters.shift()
    notify()
  }
}

function waitForCalls(deadlineMs) {
  if (inFlightCalls === 0) return Promise.resolve()
  return new Promise((resolve) => {
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

function sendFrame(message) {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${err.message}`)
  }
}

function sendError(id, code, message) {
  sendFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code, message })
}

// 反向调用通道（服务 → 宿主）：装配结果经它转发给 `session` / `workspace` 端口；
// 应答帧在 stdin 帧循环里立即结算（不排队，防堵死串行链）。
const LINK = new PortLink((message) => sendFrame(message))
const HANDLERS = createHandlers({ identity: IDENTITY, session: LINK, workspace: LINK })

function declaredMethods(port) {
  const declared = METHODS[port]
  if (Array.isArray(declared)) return declared.filter((item) => typeof item === 'string')
  return []
}

/** 帧 `env`：宿主填写、机械；缺失回落 `{run:null, thread:null, now:0}`（服务绝不自取时钟）。 */
function parseEnv(raw) {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
  }
}

async function handleCall(message) {
  const id = typeof message['id'] === 'string' ? message['id'] : ''
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
    if (err instanceof BadArgsError) {
      sendError(id, 'bad_args', err.message)
    } else {
      log(`method ${method} failed: ${err.message}`)
      sendError(id, 'internal', 'handler failed')
    }
  } finally {
    endCall()
  }
}

function shutdown() {
  if (exiting) return
  exiting = true
  LINK.failAll()
  inbound.close()
  setTimeout(() => process.exit(0), 10).unref?.()
}

async function handle(message) {
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
let chain = Promise.resolve()
process.stdin.on('data', (chunk) => {
  let messages
  try {
    messages = decoder.push(chunk)
  } catch (err) {
    log(`bad frame: ${err.message}`)
    return
  }
  for (const message of messages) {
    // 反向调用应答立即结算（不排队）：否则正在 await port.result 的 call 会把串行链堵死。
    if (isRecord(message) && LINK.settle(message)) continue
    chain = chain.then(() => handle(message)).catch((err) => log(`handle error: ${err.message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

inbound.start()
log(`ui-sidebar ready (pid ${process.pid})`)
