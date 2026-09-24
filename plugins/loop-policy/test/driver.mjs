// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧；
// 作为宿主侧应答反向调用 `port.call`——用假实现注入全部节点提供者（context / model / guard / approval /
// tools / session / retrieval / router / evolve-metrics）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { H } from '../execute/hash.ts'

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

/** 反向调用失败标记：提供者回 `{__error:{code,message}}` 时宿主回 `port.error`。 */
export function portError(code, message = '') {
  return { __error: { code, message } }
}

/** 默认节点提供者：全部返回可用的确定性值（可被单测覆盖）。 */
export function defaultProviders(overrides = {}) {
  const providers = {
    'context.build': (args) => {
      const extra = Array.isArray(args.extra_messages) ? args.extra_messages : []
      return {
        messages: [{ role: 'user', content: 'hello' }, ...extra],
        params: { model: args.config?.model ?? 'stub' },
        manifest: { dropped: 0 },
      }
    },
    'model.chat': (args) => {
      const last = Array.isArray(args.messages) && args.messages.length > 0 ? args.messages[args.messages.length - 1] : null
      if (last && last.role === 'tool') return { ok: true, text: 'done after tools', tool_calls: [], usage: { tokens: 10 } }
      return { ok: true, text: 'hi there', tool_calls: [], usage: { tokens: 5 } }
    },
    'guard.judge': (args) => {
      const calls = Array.isArray(args.calls) ? args.calls : []
      const decisions = calls.map((call, index) => ({ index, port: call.port ?? '', tool: call.tool ?? '', verdict: 'allow' }))
      return { decisions, summary: { allow: decisions.length, escalate: 0, deny: 0 } }
    },
    'approval.enqueue': () => ({
      $directives: [
        { kind: 'write', request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: { id: 'ap-1' } } }] } } },
        { kind: 'extern', payload: { ok: true, id: 'ap-1', count: 1, pending: 1 } },
      ],
    }),
    'tools.dispatch': (args) => {
      const calls = Array.isArray(args.calls) ? args.calls : []
      return { results: calls.map((call, index) => ({ call_id: call.call_id ?? `call-${index}`, ok: true, result: { tool: call.tool } })) }
    },
    'session.commit': (args) => ({
      $directives: [
        {
          kind: 'write',
          request: {
            op: 'batch',
            args: { ops: [{ op: 'put', args: { body: { id: 'msg-1', role: 'assistant', content: args.assistant?.content ?? '' } } }] },
          },
        },
        { kind: 'extern', payload: { ok: true, reply: args.assistant?.content ?? '', conversation: args.conversation ?? null } },
      ],
    }),
    'retrieval.search': () => ({ items: [] }),
    'router.select': (args) => args.primary,
    'evolve-metrics.shadow': () => ({ status: 'pass', metric_id: 'metric-1' }),
  }
  return { ...providers, ...overrides }
}

/** 启动服务并返回请求接口。 */
export function startService({ providers = {}, env = FIXED_ENV } = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const resolvedProviders = { ...defaultProviders(), ...providers }
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        respond(message)
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

  function respond(message) {
    const key = `${message.port}.${message.method}`
    const provider = resolvedProviders[key]
    if (provider === undefined) {
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.error', error: 'unresolved_cap', message: key }))
      return
    }
    Promise.resolve(provider(message.args ?? {}, message))
      .then((value) => {
        if (value && typeof value === 'object' && value.__error) {
          child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.error', ...value.__error }))
          return
        }
        child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', value: value ?? null }))
      })
      .catch((err) => {
        child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.error', error: 'internal', message: err.message }))
      })
  }

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`))
      }, 20000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}: ${JSON.stringify(message)}`))
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
    hello: () => request('hello', { impl: 'loop-policy', gen: 'gen-1' }, 'manifest'),
    call: (port, method, args, callEnv = env) => request('call', { port, method, args, env: callEnv }, ['result', 'error']),
    interpret: (bag, callEnv = env) => request('call', { port: 'loop-policy', method: 'interpret', args: bag, env: callEnv }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 递归收集所有 `$directives` 条目。 */
export function directivesOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Array.isArray(value.$directives) ? value.$directives : []
}

/** 取所有 write 计划里的子操作。 */
export function writeOps(value) {
  const ops = []
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'write' && directive.request && directive.request.args) {
      const args = directive.request.args
      if (Array.isArray(args.ops)) ops.push(...args.ops)
      else ops.push({ op: directive.request.op, args })
    }
  }
  return ops
}

/** 取所有 write 计划，各返回其 ops 数组（保留批次边界）。 */
export function writeBatches(value) {
  const batches = []
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'write' && directive.request?.args && Array.isArray(directive.request.args.ops)) {
      batches.push(directive.request.args.ops)
    }
  }
  return batches
}

/** 批内 `$n` 替换（宿主内核 substitute 口径）；越界 / 指向非 put 即抛。 */
function substitute(value, acc, k) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, acc, k))
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$n') {
    const j = value.$n
    if (!Number.isInteger(j) || j < 0 || j >= k || acc[j] === null) throw new Error(`bad_selfref ${j} at ${k}`)
    return acc[j]
  }
  const out = {}
  for (const key of keys) out[key] = substitute(value[key], acc, k)
  return out
}

/** 按内核 argsHash 口径解析一批 ops：`$n` 替换 + 每条 def 键（put 才有产物）。 */
export function resolveBatch(ops) {
  const acc = []
  const out = []
  for (let k = 0; k < ops.length; k++) {
    const args = substitute(ops[k].args, acc, k)
    const hash = H(args)
    out.push({ op: ops[k].op, args, hash })
    acc.push(ops[k].op === 'put' ? hash : null)
  }
  return out
}

/** 宿主投影 assembleGenBody 的补丁组装口径（本插件补丁只用 replace）。 */
export function assemblePatch(baseBody, patches) {
  const doc = JSON.parse(JSON.stringify(baseBody))
  for (const patch of patches) {
    if (patch.op !== 'replace') continue
    let node = doc
    for (let i = 0; i < patch.path.length - 1; i++) node = node[patch.path[i]]
    node[patch.path[patch.path.length - 1]] = JSON.parse(JSON.stringify(patch.value))
  }
  return doc
}

/**
 * 组装一批 write ops 里的 evolution 世代（宿主投影口径）：
 * 整份世代取 payload def body；补丁世代取 baseBody 组装后按序应用补丁。
 * 返回 `{ body, defs, addGen, patchOps }`（无 add_gen 时 body 为 null）。
 */
export function assembleEvolutionBatch(batch, baseBody) {
  const resolved = resolveBatch(batch)
  const defs = {}
  for (const item of resolved) if (item.op === 'put') defs[item.hash] = item.args.body
  const addGen = resolved.find((item) => item.op === 'add_gen' && item.args.id === 'evolution') ?? null
  if (addGen === null) return { body: null, defs, addGen: null, patchOps: null }
  const defBody = defs[addGen.args.payload]
  if (addGen.args.base === undefined) return { body: defBody, defs, addGen, patchOps: null }
  const patchOps = defBody?.ops ?? null
  return { body: patchOps === null ? null : assemblePatch(baseBody, patchOps), defs, addGen, patchOps }
}
