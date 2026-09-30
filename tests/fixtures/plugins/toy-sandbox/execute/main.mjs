// 鍚屽悕 toy 鏈嶅姟锛氬涓绘湇鍔″崗璁抚寰幆锛坉ocs/protocol.md 搂浜岋級銆?// 韬唤 / 鑳藉姏 / 鏂规硶鑷鍚屽寘 plugin.json锛涜涓烘寜韬唤鍒嗘淳锛涗笉璇绘姇褰便€佷笉鍐欎笘鐣屻€佷笉鍙栨椂闂撮殢鏈恒€?// stdout 鍙彂鍗忚甯э紝鏃ュ織璧?stderr锛泂tdin EOF / close / error 鍗宠嚜閫€鍑恒€?
import { readFileSync } from 'node:fs'

const PLUGIN = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
const IDENTITY = PLUGIN.identity
const IMPLEMENTS = PLUGIN.implements
const METHODS = PLUGIN.methods
const PROTOCOL = PLUGIN.protocol
const STATE = PLUGIN.state
const BEHAVIOR = readBehavior()

/** 鍙€?`e2e.json`锛氭寜鏂规硶瑕嗙洊杩斿洖鍊?/ 娉ㄥ叆閿欒锛堟祴璇曞す鍏风敤浜庡埗閫犲け璐ヨ矾寰勶級銆?*/
function readBehavior() {
  try {
    return JSON.parse(readFileSync(new URL('../e2e.json', import.meta.url), 'utf8'))
  } catch {
    return { errors: {}, values: {} }
  }
}

const WORKSPACE = {
  id: 'w-e2e',
  name: 'e2e',
  path: process.env.CHRONO_PLUGIN_STATE ?? process.cwd(),
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function behavior(capability, method, args) {
  if (IDENTITY === 'tool-fs') {
    if (method === 'describe') {
      return {
        ok: true,
        tools: [
          {
            name: 'read',
            intent: '璇诲彇涓€涓枃鏈枃浠剁殑鍐呭銆?,
            when_to_use: '闇€瑕佹煡鐪嬫枃浠跺唴瀹规椂銆?,
            param_semantics: { path: '鏂囦欢璺緞銆? },
            boundaries: '鍙鍗曟枃浠躲€?,
            description: '璇绘枃鏈枃浠讹紱杩斿洖 {text}銆?,
            argsSchema: {
              type: 'object',
              properties: { path: { type: 'string', minLength: 1 } },
              required: ['path'],
              additionalProperties: false,
            },
            caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
            idempotent: true,
            render: { form: 'line', label: 'read', summary: '{path}' },
          },
        ],
      }
    }
    const callArgs = isRecord(args) && isRecord(args.args) ? args.args : {}
    const path = typeof callArgs.path === 'string' ? callArgs.path : ''
    return { ok: true, result: { path, text: `toy-read:${path}` } }
  }
  if (IDENTITY === 'sandbox') {
    if (method === 'capabilities') return { ok: true, tiers: ['auto', 'severe', 'review', 'deny'] }
    if (method === 'exec') return { ok: true, code: 0, stdout: '', stderr: '' }
    return { ok: true }
  }
  if (IDENTITY === 'workspace') {
    if (method === 'list' || method === 'read') return { ok: true, workspaces: [WORKSPACE] }
    return { ok: true }
  }
  if (IDENTITY === 'embedding') {
    if (method === 'chunk') return { ok: true, chunks: [] }
    return { ok: true, vectors: [] }
  }
  if (IDENTITY === 'evolve-metrics') return { ok: true }
  return { ok: true }
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
  process.stderr.write(`[${IDENTITY}] ${line}\n`)
}

function handle(message) {
  if (!isRecord(message)) return
  switch (message.kind) {
    case 'hello':
      writeFrame({
        v: PROTOCOL,
        id: message.id,
        kind: 'manifest',
        identity: IDENTITY,
        implements: IMPLEMENTS,
        methods: METHODS,
        protocol: PROTOCOL,
        state: STATE,
      })
      return
    case 'probe':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'ack' })
      return
    case 'drain':
      writeFrame({ v: PROTOCOL, id: message.id, kind: 'bye' })
      return
    case 'call': {
      const id = typeof message.id === 'string' ? message.id : ''
      const capability = typeof message.port === 'string' ? message.port : ''
      const method = typeof message.method === 'string' ? message.method : ''
      if (!IMPLEMENTS.includes(capability)) {
        writeFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code: 'unresolved_cap', message: `unknown capability ${capability}` })
        return
      }
      const injected = BEHAVIOR.errors?.[method]
      if (injected !== undefined) {
        writeFrame({ v: PROTOCOL, id, kind: 'error', ok: false, code: injected.code, message: injected.message })
        return
      }
      const value = Object.hasOwn(BEHAVIOR.values ?? {}, method) ? BEHAVIOR.values[method] : behavior(capability, method, message.args)
      writeFrame({ v: PROTOCOL, id, kind: 'result', ok: true, value })
      return
    }
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
