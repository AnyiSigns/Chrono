// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call 帧，并自动应答反向调用 `port.call`
// （模拟宿主侧路由）。提供者用 `{ <port>: { <method>: (args) => value | {error, message} } }` 注入。
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

/**
 * 启动服务并返回请求 / 反向调用接口。`providers` 可后续用 `setProvider` 修改（同一对象引用）。
 */
export function startService(options = {}) {
  const providers = options.providers ?? {}
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  /** 提供者回值原样作 `port.result.value`；要模拟传输失败请让 bridge 抛错。 */
  function respond(frameId, outcome) {
    if (!child.stdin.writable) return
    child.stdin.write(encodeFrame({ v: '1', id: frameId, kind: 'port.result', ok: true, value: outcome }))
  }

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        const provider = providers[message.port]
        const fn = provider?.[message.method]
        if (typeof fn !== 'function') {
          child.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'port.error',
              ok: false,
              error: 'unresolved_cap',
              message: `no provider ${message.port}.${message.method}`,
            }),
          )
          continue
        }
        Promise.resolve()
          .then(() => fn(message.args))
          .then((outcome) => respond(message.id, outcome))
          .catch((err) =>
            child.stdin.write(
              encodeFrame({
                v: '1',
                id: message.id,
                kind: 'port.error',
                ok: false,
                error: 'bridge_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
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
    providers,
    request,
    setProvider: (port, method, fn) => {
      providers[port] = { ...(providers[port] ?? {}), [method]: fn }
    },
    removeProvider: (port, method) => {
      if (providers[port] !== undefined) delete providers[port][method]
    },
    hello: () => request('hello', { impl: 'tools', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'tools', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 一个合法工具声明（四要素齐备、caps 对象形、argsSchema 白名单子集）。 */
export function toolDecl(overrides = {}) {
  return {
    name: 'read',
    intent: '读取一个文本文件的内容。',
    when_to_use: '需要查看文件内容时。',
    param_semantics: { path: '文件路径。' },
    boundaries: '只读单文件；找文件用 glob。',
    description: '读文本文件；返回 {text}。',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
    idempotent: false,
    render: { form: 'line', label: 'read', summary: '{path}' },
    ...overrides,
  }
}

/** 一个合法绑定项。 */
export function bindingItem(overrides = {}) {
  return {
    class: 'retrieval',
    method: 'search',
    intent: '检索长期记忆。',
    when_to_use: '需要语义召回记忆时。',
    param_semantics: { query: '检索词。' },
    boundaries: '只读检索；写入用 memory。',
    argsSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: true,
    ...overrides,
  }
}

/** #44 `record` 的规范绑定项（工具名 `record` 直绑 `evolve-metrics.record`；idempotent:false）。 */
export function recordBinding(overrides = {}) {
  return {
    class: 'evolve-metrics',
    method: 'record',
    intent: '把用户原始请求落成一条 user_request 证据。',
    when_to_use: '用户驱动结构变更、需先留证再交提案时。',
    param_semantics: {
      user_message_def: '本回合首条用户消息 def（由调用方在派发时注入）。',
      workspace_id: '证据所属工作区 id（分区键）。',
    },
    boundaries: '只产证据、不产提案、不发 eff；提案用 orchestration.propose。',
    // 两个参数由调用方在派发时注入（模型不知哈希），故声明为可选、不 required。
    argsSchema: {
      type: 'object',
      properties: { user_message_def: {}, workspace_id: { type: 'string' } },
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: false,
    render: { form: 'card', label: 'record', summary: 'record  {result.evidence_id}', tone: 'plain', detail: { kind: 'json' } },
    ...overrides,
  }
}

/** guard.judge 的 allow 兜底：按 calls 逐项回 allow。 */
export function guardAllow(args) {
  const calls = Array.isArray(args?.calls) ? args.calls : []
  return {
    decisions: calls.map((call, index) => ({ index, port: call.port, tool: call.tool, verdict: 'allow', reason: 'allowed' })),
    summary: { allow: calls.length, escalate: 0, deny: 0 },
  }
}

/** guard.judge：按 tool 名映射 verdict（缺省 allow）。 */
export function guardByTool(map) {
  return (args) => {
    const calls = Array.isArray(args?.calls) ? args.calls : []
    return {
      decisions: calls.map((call, index) => ({
        index,
        port: call.port,
        tool: call.tool,
        verdict: map[call.tool] ?? 'allow',
        reason: 'test',
      })),
      summary: { allow: 0, escalate: 0, deny: 0 },
    }
  }
}
