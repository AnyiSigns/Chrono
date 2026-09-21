// `model-stub` 服务进程：宿主服务协议帧循环（docs/protocol.md §二）。
// 实现能力类 `model` 的 `chat`：确定性回包（同输入同输出、逐字节可复现）。
// 不读投影、不写世界、不取时间 / 随机；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。

import { createHash } from 'node:crypto'

const IDENTITY = 'model-stub'
const CAPABILITY = 'model'
const METHODS = ['chat']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 稳定序列化（对象键排序、递归），保证同输入同字节。 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function writeFrame(message) {
  process.stdout.write(encodeFrame(message))
}

function log(line) {
  process.stderr.write(`[model-stub] ${line}\n`)
}

function parseEnv(raw) {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0 }
  return {
    run: typeof raw.run === 'string' ? raw.run : null,
    thread: typeof raw.thread === 'string' ? raw.thread : null,
    now: typeof raw.now === 'number' && Number.isFinite(raw.now) ? raw.now : 0,
  }
}

/** 确定性 chat：文本 = 规范化输入的 sha256 前缀；用量按消息字符数推导。 */
function chat(args, env) {
  const digest = createHash('sha256').update(canonical(args)).digest('hex').slice(0, 16)
  const messages = isRecord(args) && Array.isArray(args.messages) ? args.messages : []
  const promptTokens = messages.reduce((total, message) => total + (isRecord(message) && typeof message.content === 'string' ? message.content.length : 0), 0)
  const text = `model-stub:${digest}`
  const payload = { run: env.run, thread: env.thread, model: isRecord(args) && isRecord(args.config) && typeof args.config.model === 'string' ? args.config.model : 'stub', protocol: 'stub', text, done: true }
  writeFrame({ v: '1', id: `model-stub-evt-${digest}`, kind: 'event', topic: 'model.delta', payload })
  return {
    ok: true,
    text,
    tool_calls: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: text.length, total_tokens: promptTokens + text.length },
    model: payload.model,
    protocol: 'stub',
  }
}

function sendError(id, code, message) {
  writeFrame({ v: '1', id, kind: 'error', ok: false, code, message })
}

function handleCall(message) {
  const id = typeof message.id === 'string' ? message.id : ''
  if (message.port !== CAPABILITY) {
    sendError(id, 'unresolved_cap', `unknown capability ${String(message.port)}`)
    return
  }
  if (message.method !== 'chat') {
    sendError(id, 'unknown_method', `unknown method ${String(message.method)}`)
    return
  }
  const args = message.args === undefined || message.args === null ? {} : message.args
  if (!isRecord(args)) {
    sendError(id, 'bad_args', 'args must be an object')
    return
  }
  writeFrame({ v: '1', id, kind: 'result', ok: true, value: chat(args, parseEnv(message.env)) })
}

function handle(message) {
  if (!isRecord(message)) return
  switch (message.kind) {
    case 'hello':
      writeFrame({ id: message.id, kind: 'manifest', v: '1', identity: IDENTITY, implements: [CAPABILITY], methods: { [CAPABILITY]: METHODS }, protocol: '1', state: 'recomputable' })
      return
    case 'probe':
      writeFrame({ v: '1', id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      writeFrame({ v: '1', id: message.id, kind: 'ack' })
      return
    case 'drain':
      writeFrame({ v: '1', id: message.id, kind: 'bye' })
      return
    case 'call':
      handleCall(message)
      return
    default:
      return
  }
}

let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0)
    if (buffered.length < 4 + length) break
    const body = buffered.subarray(4, 4 + length).toString('utf8')
    buffered = buffered.subarray(4 + length)
    try {
      handle(JSON.parse(body))
    } catch (err) {
      log(`handle error: ${err.message}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))

log(`service started (pid ${process.pid})`)
