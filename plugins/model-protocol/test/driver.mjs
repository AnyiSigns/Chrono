// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，收集 event，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 启动服务并返回请求 / 事件接口；`secretsResolver(method, args)` 应答反向调用。 */
export function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_PLUGIN_STATE: '', ...(options.env ?? {}) },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const secretsResolver = options.secretsResolver ?? (() => ({ error: 'secret_missing', message: 'no resolver' }))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        const outcome = secretsResolver(message.port, message.method, message.args)
        const frame = outcome.error
          ? { v: '1', id: message.id, kind: 'port.error', ok: false, error: outcome.error, message: outcome.message ?? outcome.error }
          : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
        child.stdin.write(encodeFrame(frame))
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`))
      }, 10000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    exit,
    events,
    portCalls,
    stderr,
    request,
    hello: () => request('hello', { impl: 'model-protocol', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'model', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 一个最小 config（连接实例）。 */
export function configFor(serverUrl, overrides = {}) {
  return {
    base_url: serverUrl,
    model: 'test-model',
    params: { temperature: 0.2, max_tokens: 64, reasoning: 'low' },
    quirks: {
      impl: 'protocol',
      protocol: 'openai-chat',
      auth_style: 'bearer',
      system_role: 'system',
      reasoning_field: 'reasoning_effort',
      reasoning_map: { low: 'low', medium: 'medium', high: 'high' },
      reasoning_response_field: 'reasoning_content',
      max_tokens_field: 'max_tokens',
      models_path: '/models',
      stream_usage: 'final_chunk',
      extra_headers: {},
    },
    ...overrides,
  }
}

export function chatBag(serverUrl, overrides = {}) {
  const { config, messages, ...rest } = overrides
  return {
    config: configFor(serverUrl, config),
    messages: messages ?? [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
    ...rest,
  }
}
