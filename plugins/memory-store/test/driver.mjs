// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由；默认桥接确定性假向量化后端，可注入 bridge）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export const DIM = 384

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

/** 确定性 FNV-1a 32 位（与假向量化后端共用，供测试构造查询向量）。 */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 文本 → 单位向量：命中桶置 1（同文本同向量、不同文本近似正交）。 */
export function testVector(text, dim = DIM) {
  const vector = new Array(dim).fill(0)
  vector[fnv1a(text) % dim] = 1
  return vector
}

/** 指定桶权重的查询向量（用于制造有区分度的分数）。 */
export function queryVector(weights, dim = DIM) {
  const vector = new Array(dim).fill(0)
  for (const [text, weight] of Object.entries(weights)) vector[fnv1a(text) % dim] = weight
  return vector
}

/** 默认假向量化后端：chunk 整段一块，embed 回确定性单位向量。 */
export function defaultBridge(port, method, args) {
  if (port !== 'embedding') return { error: 'not_ready', message: 'no resolver' }
  if (method === 'chunk') {
    const text = typeof args?.text === 'string' ? args.text : ''
    return { value: [{ index: 0, start: 0, end: [...text].length, text }] }
  }
  if (method === 'embed') {
    const texts = Array.isArray(args?.texts) ? args.texts : []
    const model = typeof args?.model === 'string' ? args.model : 'granite-97m'
    return { value: { model, dim: DIM, vectors: texts.map((text) => testVector(text)) } }
  }
  return { error: 'not_ready', message: 'no resolver' }
}

/** 启动服务并返回请求 / 反向调用接口；`bridge(port, method, args)` 应答反向调用。 */
export function startService(options = {}) {
  const env = { ...process.env }
  if (options.stateDir !== undefined) env.CHRONO_PLUGIN_STATE = options.stateDir
  else delete env.CHRONO_PLUGIN_STATE
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const frames = []
  const portCalls = []
  const stderr = []
  const bridge = options.bridge ?? ((port, method, args) => Promise.resolve(defaultBridge(port, method, args)))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      frames.push(message)
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve()
          .then(() => bridge(message.port, message.method, message.args))
          .then((outcome) => {
            if (!child.stdin.writable) return
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
    frames,
    portCalls,
    stderr,
    request,
    hello: () => request('hello', { impl: 'memory-store', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'memory', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
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

/** 轮询 search 直到索引就绪（或超时）。 */
export async function waitReady(drv, args, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await drv.call('search', args)
    if (result.kind === 'result' && result.value?.status === 'ready') return result
    if (Date.now() > deadline) throw new Error(`search 未就绪：${JSON.stringify(result)}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
}
