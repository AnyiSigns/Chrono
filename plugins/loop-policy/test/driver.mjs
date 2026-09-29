// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧；
// 作为宿主侧应答反向调用 `port.call`——用假实现注入全部节点提供者（context / model / guard / approval /
// tools / session / retrieval / router / evolve-metrics）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { encodeFrame, createFrameDecoder as createDecoder } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export { encodeFrame, createDecoder }

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/**
 * 宿主注入的**有效 pins**（声明 `pins` ∪ one-needs 绑定）：迁移后 `plugin.json.pins` 只余 `host`，
 * 驱动按宿主口径经 spawn env `CHRONO_PLUGIN_PINS` 注入；bag 内的场景覆盖（`bag.pins`）仍优先。
 */
export const DEFAULT_PINS = {
  session: 'session',
  model: 'model-protocol',
  context: 'context-window',
  retrieval: 'memory-retrieval',
  compress: 'compress',
  guard: 'guard',
  approval: 'approval',
  tools: 'tools',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
  host: 'host',
}

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
    'session.step_append': () => ({ ok: true, turn_id: 't1', deduped: false }),
    'session.turn_settle': (args) => ({ ok: true, turn_id: args.turn_id, outcome: args.outcome, persisted: true }),
    'retrieval.search': () => ({ items: [] }),
    'compress.summarize': (args) => ({
      ok: true,
      kind: 'summarize',
      conversation: args.conversation ?? null,
      covered_upto: args.covered_upto ?? null,
      summary: {
        goal: typeof args.goal === 'string' && args.goal.length > 0 ? args.goal : 'stub summary',
        decisions: [],
        facts: ['fact-1'],
        open_questions: [],
        files: Array.isArray(args.files) ? args.files : [],
        next_steps: [],
      },
      dedup: 'text',
    }),
    'router.select': (args) => args.primary,
    'evolve-metrics.shadow': () => ({ status: 'pass', metric_id: 'metric-1' }),
  }
  return { ...providers, ...overrides }
}

/** 启动服务并返回请求接口。 */
export function startService({ providers = {}, env = FIXED_ENV, pins = DEFAULT_PINS } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_PLUGIN_PINS: JSON.stringify(pins) },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const resolvedProviders = { ...defaultProviders(), ...providers }
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  // 回合步记录台账：缺会话 owner 时以驱动代收 step_append，供段续跑重建（模拟 session.read 的 turns[].steps）。
  const stepStore = new Map()

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
    if (message.port === 'session' && message.method === 'step_append' && message.args && typeof message.args.turn_id === 'string') {
      const list = stepStore.get(message.args.turn_id) ?? []
      list.push(message.args)
      stepStore.set(message.args.turn_id, list)
    }
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

  /** 驱动段：一段一次 interpret；段尾若产续跑 eval，则以段终态重建 bag 续跑，直到回合终态。 */
  async function interpretTurn(initial, callEnv) {
    // item 9：生产默认不再下传 `extra_messages`；测试驱动显式 opt-in 以沿用旧的同回合上下文回灌口径。
    let current = { ...initial, compat_extra_messages: true }
    const merged = []
    let last = null
    for (let guard = 0; guard < 500; guard += 1) {
      last = await request('call', { port: 'loop-policy', method: 'interpret', args: current, env: callEnv }, ['result', 'error'])
      if (last.kind !== 'result') return last
      const dirs = directivesOf(last.value)
      const cont = dirs.find(
        (item) => item && item.kind === 'eval' && item.command === 'chat.resume' && item.args && typeof item.args.turn_id === 'string',
      )
      if (cont === undefined) break
      for (const item of dirs) {
        if (item && item.kind !== 'extern' && item.kind !== 'eval') merged.push(item)
      }
      const turnId = cont.args.turn_id
      current = {
        ...current,
        turn_id: typeof current.turn_id === 'string' ? current.turn_id : turnId,
        resume: { continuation: true, turn_id: turnId },
        session: { turns: [{ turn_id: turnId, steps: stepStore.get(turnId) ?? [] }] },
      }
    }
    if (merged.length === 0 || last === null || last.kind !== 'result') return last
    const value = last.value && typeof last.value === 'object' && !Array.isArray(last.value) ? last.value : {}
    return { ...last, value: { ...value, $directives: [...merged, ...directivesOf(value)] } }
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
    interpret: (bag, callEnv = env) => interpretTurn(bag, callEnv),
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

