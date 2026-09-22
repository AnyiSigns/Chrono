// `toy-react` 服务进程入口：服务协议帧循环 + 子应用 HTTP 服务。
// manifest 从同包 plugin.json 派生（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影：只提供健康占位方法。

import { readFileSync } from 'node:fs'
import { createFrameDecoder, log, writeFrame } from './frames.js'
import { startHttpServer } from './http-server.js'
import { resolvePort } from './port.js'

function readPlugin() {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${err.message}`)
  }
  return {}
}

const PLUGIN = readPlugin()
const IDENTITY = typeof PLUGIN.identity === 'string' ? PLUGIN.identity : 'toy-react'
const IMPLEMENTS = Array.isArray(PLUGIN.implements)
  ? PLUGIN.implements.filter((item) => typeof item === 'string')
  : ['toy.react']
const METHODS = typeof PLUGIN.methods === 'object' && PLUGIN.methods !== null ? PLUGIN.methods : {}
const PROTOCOL = typeof PLUGIN.protocol === 'string' ? PLUGIN.protocol : '1'
const STATE = typeof PLUGIN.state === 'string' ? PLUGIN.state : 'recomputable'

function manifest() {
  return {
    v: '1',
    identity: IDENTITY,
    implements: IMPLEMENTS,
    methods: METHODS,
    protocol: PROTOCOL,
    state: STATE,
  }
}

let httpServer = null
let exiting = false

function sendFrame(message) {
  if (exiting) return
  try {
    writeFrame(message)
  } catch (err) {
    log(`write frame failed: ${err.message}`)
  }
}

function sendError(id, code, message) {
  sendFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function declaredMethods(port) {
  const declared = METHODS[port]
  return Array.isArray(declared) ? declared.filter((item) => typeof item === 'string') : []
}

function handleCall(message) {
  const id = typeof message.id === 'string' ? message.id : ''
  const port = message.port
  const method = message.method
  if (typeof port !== 'string' || typeof method !== 'string') {
    sendError(id, 'bad_args', 'port and method must be strings')
    return
  }
  if (!IMPLEMENTS.includes(port) || !declaredMethods(port).includes(method)) {
    sendError(id, 'unknown_method', `unknown method ${method}`)
    return
  }
  // 唯一方法 ping：健康占位，回服务自述；无写通道、不读投影。
  sendFrame({ v: '1', id, kind: 'result', ok: true, value: { pong: true, identity: IDENTITY } })
}

function shutdown() {
  if (exiting) return
  exiting = true
  const server = httpServer
  httpServer = null
  const finish = () => setTimeout(() => process.exit(0), 10).unref?.()
  if (server !== null) {
    void server.close().then(finish, finish)
  } else {
    finish()
  }
}

function handle(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  switch (message.kind) {
    case 'hello':
      sendFrame({ id: message.id, kind: 'manifest', ...manifest() })
      return
    case 'probe':
      sendFrame({ v: '1', id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      log(`reload gen=${typeof message.gen === 'string' ? message.gen : '?'}`)
      sendFrame({ v: '1', id: message.id, kind: 'ack' })
      return
    case 'drain':
      sendFrame({ v: '1', id: message.id, kind: 'bye' })
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
    chain = chain
      .then(() => handle(message))
      .catch((err) => log(`handle error: ${err.message}`))
  }
})
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.on('error', shutdown)

const port = resolvePort(process.env)
startHttpServer({ log }, port).then(
  (server) => {
    httpServer = server
    log(`toy-react listening on 127.0.0.1:${server.port} (pid ${process.pid})`)
  },
  (err) => {
    log(`cannot listen on 127.0.0.1:${port}: ${err.message}`)
    process.exit(1)
  },
)
