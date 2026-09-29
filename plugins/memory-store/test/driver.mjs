// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由；默认桥接确定性假向量化后端，可注入 bridge）。
// 可选注入 `dataDir`（④ CHRONO_PLUGIN_DATA）与 `stateDir`（③ CHRONO_PLUGIN_STATE），用于持久化 / 分界测试。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { encodeFrame, createFrameDecoder as createDecoder } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export const DIM = 384

export { encodeFrame, createDecoder }

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

/** L2 归一（与 vector-index 提供方同口径）。 */
function normalize(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return vector.map(() => 0)
  return vector.map((value) => value / norm)
}

function dot(left, right) {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index++) sum += left[index] * right[index]
  return sum
}

/**
 * 内存假 `vector-index` 服务：实现 upsert / remove / search / info / clear 与确定性 tie-break。
 * 供 memory-store 协议级测试桥接反向调用；可在会话间共享 / 手动 clear（模拟删除 ③）。
 */
export function createFakeVectorIndex() {
  let data = null
  return {
    clear() {
      data = null
      return { ok: true }
    },
    upsert(input) {
      if (data === null || data.modelId !== input.model || data.dim !== input.dim) {
        data = { modelId: input.model, dim: input.dim, count: input.count, records: [] }
      }
      const keys = new Set(input.records.map((record) => record.key))
      if (keys.size > 0) data.records = data.records.filter((record) => !keys.has(record.key))
      for (const record of input.records) {
        data.records.push({
          key: record.key,
          chunk_index: record.chunk_index,
          vector: normalize(record.vector),
        })
      }
      data.count = input.count
      return {
        ok: true,
        present: true,
        model: data.modelId,
        dim: data.dim,
        count: data.count,
        size: data.records.length,
      }
    },
    remove(keys) {
      if (data === null) return { ok: true, removed: 0, size: 0 }
      const set = new Set(keys)
      const before = data.records.length
      data.records = data.records.filter((record) => !set.has(record.key))
      return { ok: true, removed: before - data.records.length, size: data.records.length }
    },
    search(query, topK) {
      if (data === null) return { ok: true, hits: [] }
      const hits = data.records.map((record) => ({
        key: record.key,
        chunk_index: record.chunk_index,
        score: dot(query, record.vector),
      }))
      hits.sort(
        (left, right) =>
          right.score - left.score ||
          (left.key < right.key ? -1 : left.key > right.key ? 1 : 0) ||
          left.chunk_index - right.chunk_index,
      )
      return { ok: true, hits: hits.slice(0, topK) }
    },
    info() {
      if (data === null) return { ok: true, present: false, records: [] }
      return {
        ok: true,
        present: true,
        model: data.modelId,
        dim: data.dim,
        count: data.count,
        size: data.records.length,
        records: data.records.map((record) => ({
          key: record.key,
          chunk_index: record.chunk_index,
          vector: [...record.vector],
        })),
      }
    },
  }
}

/** 把 `vector-index.*` 反向调用派发到内存假服务，回 `{value}` / `{error,message}`。 */
function vectorIndexOutcome(fake, method, args) {
  if (method === 'upsert') return { value: fake.upsert(args) }
  if (method === 'remove') return { value: fake.remove(Array.isArray(args?.keys) ? args.keys : []) }
  if (method === 'search') {
    return {
      value: fake.search(
        Array.isArray(args?.query_vector) ? args.query_vector : [],
        args?.top_k ?? 10,
      ),
    }
  }
  if (method === 'info') return { value: fake.info() }
  if (method === 'clear') return { value: fake.clear() }
  return { error: 'unknown_method', message: `fake vector-index has no ${method}` }
}

/** 默认假后端：tokenizer.chunk 整段一块，embedding.embed 回确定性单位向量。 */
export function defaultBridge(port, method, args) {
  if (port === 'tokenizer' && method === 'chunk') {
    const text = typeof args?.text === 'string' ? args.text : ''
    return { value: [{ index: 0, start: 0, end: [...text].length, text }] }
  }
  if (port === 'embedding' && method === 'embed') {
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
  if (options.dataDir !== undefined) env.CHRONO_PLUGIN_DATA = options.dataDir
  else delete env.CHRONO_PLUGIN_DATA
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const decoder = createDecoder()
  const pending = new Map()
  const frames = []
  const portCalls = []
  const stderr = []
  const vectorIndex = options.vectorIndex ?? createFakeVectorIndex()
  const customBridge = options.bridge
  const bridge = (port, method, args) => {
    if (port === 'vector-index')
      return Promise.resolve(vectorIndexOutcome(vectorIndex, method, args))
    if (customBridge !== undefined) return Promise.resolve(customBridge(port, method, args))
    return Promise.resolve(defaultBridge(port, method, args))
  }
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
        rejectRequest(
          new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`),
        )
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
    vectorIndex,
    request,
    hello: () => request('hello', { impl: 'memory-store', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'memory', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 轮询 search 直到索引就绪（或超时）。上限取宽裕值：满载机器上原生服务启动会明显变慢。 */
export async function waitReady(drv, args, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await drv.call('search', args)
    if (result.kind === 'result' && result.value?.status === 'ready') return result
    if (Date.now() > deadline) throw new Error(`search 未就绪：${JSON.stringify(result)}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
}
