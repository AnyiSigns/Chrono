// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由；可注入同步或异步 bridge）。
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

/** 启动服务并返回请求 / 反向调用接口；`bridge(port, method, args)` 应答反向调用。 */
export function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const fallback = options.resolvePort ?? (() => ({ error: 'not_ready', message: 'no resolver' }))
  const bridge = options.bridge ?? ((port, method, args) => Promise.resolve(fallback(port, method, args)))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve()
          .then(() => bridge(message.port, message.method, message.args))
          .then((outcome) => {
            const frame = outcome.error
              ? {
                  v: '1',
                  id: message.id,
                  kind: 'port.error',
                  ok: false,
                  error: outcome.error,
                  message: outcome.message ?? outcome.error,
                }
              : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
            child.stdin.write(encodeFrame(frame))
          })
          .catch((err) => {
            if (!child.stdin.writable) return
            child.stdin.write(
              encodeFrame({
                v: '1',
                id: message.id,
                kind: 'port.error',
                ok: false,
                error: 'bridge_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          })
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

  const timeoutMs = options.timeoutMs ?? 15000
  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`))
      }, timeoutMs)
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
    hello: () => request('hello', { impl: 'compress', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'compress', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 一份最小 short-memory body（含另一会话 / 工作区，用于验证不盲写抹掉）。 */
export function memoryFixture(overrides = {}) {
  return {
    version: 1,
    sessions: {
      'c-keep': {
        summary: { goal: 'keep', decisions: [], facts: ['kept'], open_questions: [], files: [], next_steps: [] },
        covered_upto: 'msg-keep',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-keep': { summary: { goal: 'wkeep', decisions: [], facts: ['wkept'], open_questions: [], files: [] }, sources: ['c-keep'], at: '2020-01-01T00:00:00.000Z' },
    },
    ...overrides,
  }
}

/** 从计划值里取 batch 子操作与 extern 载荷。 */
export function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

export function opsOf(value) {
  const batch = directivesOf(value).find((item) => item.kind === 'write')
  return Array.isArray(batch?.request?.args?.ops) ? batch.request.args.ops : []
}

export function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}
