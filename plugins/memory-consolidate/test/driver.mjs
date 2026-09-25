// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由；可注入 bridge）。
// 内置内存假 owner 服务：short-memory（read/apply）、memory-store（list/append/delete/pin/edit）、
// session（read）；compress.summarize 与 embedding.chunk/embed 走可配置假后端。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export const DIM = 64

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

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: Date.parse('2023-11-14T00:00:00.000Z') }

/** 确定性 FNV-1a 32 位（假向量化后端用）。 */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 指定桶权重的向量（补齐到 dim；测试造有区分度 / 近似重复的向量）。 */
export function vec(weights, dim = 4) {
  const vector = new Array(dim).fill(0)
  for (const [index, weight] of Object.entries(weights)) vector[Number(index)] = weight
  return vector
}

/** 文本 → 向量：命中显式表优先，否则按 FNV 桶 one-hot（dim 长）。 */
export function vectorFor(text, options = {}) {
  if (options.vectors && Object.hasOwn(options.vectors, text)) return options.vectors[text]
  const dim = options.dim ?? DIM
  const vector = new Array(dim).fill(0)
  vector[fnv1a(text) % dim] = 1
  return vector
}

/** #3 body：两会话同属 w-1 + 一个已有工作区记忆（用于验证合并 / 去重 / sources 追加）。 */
export function shortMemoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-1': {
        summary: { goal: 'G1', decisions: [], facts: ['f1', 'f2'], open_questions: [], files: [], next_steps: [] },
        covered_upto: 'm1',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
      'c-2': {
        summary: { goal: 'G2', decisions: [], facts: ['f2', 'f3'], open_questions: [], files: [], next_steps: [] },
        covered_upto: 'm2',
        at: '2020-01-02T00:00:00.000Z',
        expires_at: '2020-01-03T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-1': {
        summary: { goal: 'WG', decisions: [], facts: ['old'], open_questions: [], files: [] },
        sources: ['c-0'],
        at: '2020-01-01T00:00:00.000Z',
      },
    },
  }
}

/** #11 body：会话 → 工作区归属。 */
export function sessionFixture() {
  return {
    current: 'c-1',
    conversations: [
      { id: 'c-1', workspace_id: 'w-1' },
      { id: 'c-2', workspace_id: 'w-1' },
    ],
  }
}

/** 内存假 short-memory：read / apply。 */
export function createFakeShortMemory(initial = {}) {
  const memory = structuredClone({ version: 1, sessions: {}, workspaces: {}, ...initial })
  return {
    memory,
    apply(args) {
      for (const [id, record] of Object.entries(args?.set_sessions ?? {})) {
        if (record === null) delete memory.sessions[id]
        else memory.sessions[id] = record
      }
      for (const id of args?.del_sessions ?? []) delete memory.sessions[id]
      for (const [id, record] of Object.entries(args?.set_workspaces ?? {})) {
        if (record === null) delete memory.workspaces[id]
        else memory.workspaces[id] = record
      }
      for (const id of args?.del_workspaces ?? []) delete memory.workspaces[id]
      return { ok: true, changed: 1 }
    },
  }
}

/** 内存假 memory-store：list / append / delete / pin / edit。 */
export function createFakeMemory(initialEntries = [], initialPinned = {}) {
  const entries = structuredClone(initialEntries)
  const pinned = { ...initialPinned }
  return {
    entries,
    pinned,
    call(method, args) {
      if (method === 'list') {
        return { ok: true, kind: 'list', entries: structuredClone(entries), count: entries.length, pinned: { ...pinned } }
      }
      if (method === 'append') {
        const added = []
        for (const entry of args?.entries ?? []) {
          const existing = entries.find((item) => item.id === entry.id)
          if (existing !== undefined) continue
          entries.push(structuredClone(entry))
          added.push(entry.id)
        }
        return { ok: true, kind: 'append', added, count: entries.length }
      }
      if (method === 'delete') {
        for (const id of args?.ids ?? []) {
          const index = entries.findIndex((item) => item.id === id)
          if (index >= 0) entries.splice(index, 1)
        }
        return { ok: true, kind: 'delete', deleted: args?.ids ?? [] }
      }
      if (method === 'pin') {
        if (args?.pinned === false) delete pinned[args.id]
        else pinned[args.id] = true
        return { ok: true, kind: 'pin', id: args.id, pinned: args.pinned !== false }
      }
      if (method === 'edit') {
        const entry = entries.find((item) => item.id === args?.id)
        if (entry === undefined) return { ok: false, kind: 'edit', id: args?.id, reason: 'not_found' }
        entry.text = args.text
        return { ok: true, kind: 'edit', id: args.id, text: args.text }
      }
      return undefined
    },
  }
}

/** #21 单条目（用于 L3 去重 / 淘汰 / 编辑）。 */
export function memoryEntry(entry = {}) {
  return {
    id: entry.id ?? 'm-1',
    text: entry.text ?? 'text',
    meta: { source: 'manual', workspace: 'w-1', at: entry.at ?? '2023-01-01T00:00:00.000Z', tags: entry.tags ?? [] },
    weight: entry.weight ?? null,
  }
}

/** 默认假后端：chunk / embed / summarize / owner 服务。 */
export function defaultBridge(options = {}) {
  return (port, method, args) => {
    if (port === 'embedding' && method === 'chunk') {
      const text = typeof args?.text === 'string' ? args.text : ''
      return { value: [{ index: 0, start: 0, end: [...text].length, text }] }
    }
    if (port === 'embedding' && method === 'embed') {
      const texts = Array.isArray(args?.texts) ? args.texts : []
      return {
        value: {
          model: typeof args?.model === 'string' ? args.model : 'granite-97m',
          dim: (options.vectors && options.vectors[texts[0]]?.length) ?? options.dim ?? DIM,
          vectors: texts.map((text) => vectorFor(text, options)),
        },
      }
    }
    if (port === 'compress' && method === 'summarize') {
      const summary = options.summary ?? { goal: 'merged-goal', facts: [] }
      return { value: { ok: true, kind: 'summarize', summary } }
    }
    return { error: 'not_ready', message: 'no resolver' }
  }
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
  const shortMemory = options.shortMemory ?? createFakeShortMemory(options.memory)
  const memory = options.memoryStore ?? createFakeMemory(options.entries, options.pinned)
  const session = options.session ?? sessionFixture()
  const fallback = defaultBridge(options)
  const bridge = options.bridge ?? ((port, method, args) => Promise.resolve(fallback(port, method, args)))
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      frames.push(message)
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve()
          .then(() => {
            if (message.port === 'short-memory') {
              if (message.method === 'read') return { value: structuredClone(shortMemory.memory) }
              if (message.method === 'apply') return { value: shortMemory.apply(message.args ?? {}) }
            }
            if (message.port === 'memory') {
              const outcome = memory.call(message.method, message.args ?? {})
              if (outcome === undefined) return { error: 'unknown_method', message: message.method }
              return { value: outcome }
            }
            if (message.port === 'session' && message.method === 'read') {
              return { value: structuredClone(session) }
            }
            return bridge(message.port, message.method, message.args)
          })
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
    shortMemory,
    memory,
    hello: () => request('hello', { impl: 'memory-consolidate', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'memory-maintenance', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}
