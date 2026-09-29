// 协议级测试驱动（mini-host）：spawn `node execute/main.ts`（memory-consolidate 门面），
// 并按其 `port.call` 路由：l1/l2/l3-maintenance 转发到各自的 stdio 服务（真实提供方），
// 其余 owner / 后端调用用内存假件应答。
// 内置内存假 owner 服务：short-memory（read/apply）、memory-store（list/append/delete/pin/edit）、
// session（read）；embedding.embed 与 compress.summarize 走可配置假后端。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { encodeFrame, createFrameDecoder as createDecoder } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

const PROVIDER_ENTRIES = {
  'l1-maintenance': resolve(HERE, '..', '..', 'l1-maintenance', 'execute', 'main.ts'),
  'l2-maintenance': resolve(HERE, '..', '..', 'l2-maintenance', 'execute', 'main.ts'),
  'l3-maintenance': resolve(HERE, '..', '..', 'l3-maintenance', 'execute', 'main.ts'),
}
const PROVIDER_ROOTS = {
  'l1-maintenance': resolve(HERE, '..', '..', 'l1-maintenance'),
  'l2-maintenance': resolve(HERE, '..', '..', 'l2-maintenance'),
  'l3-maintenance': resolve(HERE, '..', '..', 'l3-maintenance'),
}

export const DIM = 64
export { encodeFrame, createDecoder }

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
        summary: {
          goal: 'G1',
          decisions: [],
          facts: ['f1', 'f2'],
          open_questions: [],
          files: [],
          next_steps: [],
        },
        covered_upto: 'm1',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
      'c-2': {
        summary: {
          goal: 'G2',
          decisions: [],
          facts: ['f2', 'f3'],
          open_questions: [],
          files: [],
          next_steps: [],
        },
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
        return {
          ok: true,
          kind: 'list',
          entries: structuredClone(entries),
          count: entries.length,
          pinned: { ...pinned },
        }
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
        if (entry === undefined)
          return { ok: false, kind: 'edit', id: args?.id, reason: 'not_found' }
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
    meta: {
      source: 'manual',
      workspace: 'w-1',
      at: entry.at ?? '2023-01-01T00:00:00.000Z',
      tags: entry.tags ?? [],
    },
    weight: entry.weight ?? null,
  }
}

/** 默认假后端：embedding.embed / compress.summarize。 */
export function defaultBridge(options = {}) {
  return (port, method, args) => {
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

/** 启动门面服务并返回请求 / 反向调用接口；`bridge(port, method, args)` 应答反向调用。 */
export function startService(options = {}) {
  const env = { ...process.env }
  if (options.stateDir !== undefined) env.CHRONO_PLUGIN_STATE = options.stateDir
  else delete env.CHRONO_PLUGIN_STATE
  const timeoutMs = options.timeoutMs ?? 15000
  const portCalls = []
  const shortMemory = options.shortMemory ?? createFakeShortMemory(options.memory)
  const memory = options.memoryStore ?? createFakeMemory(options.entries, options.pinned)
  const session = options.session ?? sessionFixture()
  const fallback = defaultBridge(options)
  const bridge =
    options.bridge ?? ((port, method, args) => Promise.resolve(fallback(port, method, args)))
  const providers = new Map()
  const children = []

  function makeService(entry, cwd, allowProviders) {
    const child = spawn(process.execPath, [entry], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    children.push(child)
    const decoder = createDecoder()
    const pending = new Map()
    const stderr = []
    let seq = 0
    const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'port.call') {
          portCalls.push(message)
          respondToPortCall(child, message, allowProviders)
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

    function request(kind, fields, expect) {
      seq += 1
      const id = `${allowProviders ? 'host' : 'owner'}-${seq}`
      const expected = Array.isArray(expect) ? expect : [expect]
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectRequest(
            new Error(
              `timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`,
            ),
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
      request,
      call: (port, method, args, callEnv) => {
        const fields = { port, method, args }
        if (callEnv !== undefined) fields.env = callEnv
        return request('call', fields, ['result', 'error'])
      },
      close: () => child.stdin.end(),
      exit,
      stderr,
    }
  }

  function providerFor(port) {
    let provider = providers.get(port)
    if (provider === undefined) {
      provider = makeService(PROVIDER_ENTRIES[port], PROVIDER_ROOTS[port], false)
      providers.set(port, provider)
    }
    return provider
  }

  async function respondToPortCall(child, message, allowProviders) {
    const port = message.port
    const method = message.method
    const args = message.args ?? {}
    let outcome
    try {
      outcome = await resolvePort(port, method, args, allowProviders)
    } catch (err) {
      outcome = {
        error: 'bridge_failed',
        message: err instanceof Error ? err.message : String(err),
      }
    }
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
      : { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value ?? null }
    child.stdin.write(encodeFrame(frame))
  }

  async function resolvePort(port, method, args, allowProviders) {
    if (allowProviders && Object.hasOwn(PROVIDER_ENTRIES, port)) {
      const reply = await providerFor(port).call(port, method, args, FIXED_ENV)
      if (reply.kind === 'result') return { value: reply.value }
      return { error: reply.code ?? 'provider_error', message: reply.message ?? '' }
    }
    if (port === 'short-memory') {
      if (method === 'read') return { value: structuredClone(shortMemory.memory) }
      if (method === 'apply') return { value: shortMemory.apply(args) }
    }
    if (port === 'memory') {
      const outcome = memory.call(method, args)
      if (outcome === undefined) return { error: 'unknown_method', message: method }
      return { value: outcome }
    }
    if (port === 'session' && method === 'read') return { value: structuredClone(session) }
    return bridge(port, method, args)
  }

  const facade = makeService(ENTRY, PKG_ROOT, true)

  return {
    child: facade.child,
    exit: facade.exit,
    portCalls,
    shortMemory,
    memory,
    request: facade.request,
    hello: () => facade.request('hello', { impl: 'memory-consolidate', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      facade.request('call', { port: 'memory-maintenance', method, args, env }, [
        'result',
        'error',
      ]),
    close: () => {
      facade.close()
      for (const provider of providers.values()) provider.close()
    },
  }
}
