// 协议级测试驱动：spawn 真实 `loop-policy` 门面，并把它对 `graph-run` / `turn-ledger` / `graph-gate` 的
// 反向调用转交给真实服务；对节点能力类（context / model / guard / approval / tools / session / retrieval /
// router / evolve-metrics）由本驱动以假实现应答。跨插件联调只经 spawn 进程 + 帧转发，不 import 兄弟插件源码。
// `portCalls` / `events` 汇总自各真实服务（门面对 graph-run / turn-ledger 的内部委派不计入端口序，
// 与拆分前「门面直接派发节点」的观测口径一致）。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createFrameDecoder as createDecoder, encodeFrame } from 'plugin-sdk'
import { startBridgedService, relayFrame } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const PLUGINS_ROOT = resolve(HERE, '..', '..')

export { encodeFrame, createDecoder }

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/**
 * 宿主注入的**有效 pins**（声明 `pins` ∪ one-needs 绑定）：门面按宿主口径经 spawn env
 * `CHRONO_PLUGIN_PINS` 注入；bag 内的场景覆盖（`bag.pins`）仍优先。
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
  'graph-gate': 'graph-gate',
  'graph-run': 'graph-run',
  'turn-ledger': 'turn-ledger',
  'ref-hydrate': 'ref-hydrate',
  host: 'host',
}

/** 反向调用失败标记：提供者回 `{__error:{code,message}}` 时宿主回 `port.error`。 */
export function portError(code, message = '') {
  return { __error: { code, message } }
}

/** 默认节点提供者：全部返回可用的确定性值（可被单测覆盖）。 */
export function defaultProviders(overrides = {}) {
  const providers = {
    'ref-hydrate.hydrate': (args) => (Array.isArray(args.refs) ? {} : (args.refs ?? {})),
    'context.build': (args) => {
      const extra = Array.isArray(args.extra_messages) ? args.extra_messages : []
      return {
        messages: [{ role: 'user', content: 'hello' }, ...extra],
        params: { model: args.config?.model ?? 'stub' },
        manifest: { dropped: 0 },
      }
    },
    'model.chat': (args) => {
      const last =
        Array.isArray(args.messages) && args.messages.length > 0
          ? args.messages[args.messages.length - 1]
          : null
      if (last && last.role === 'tool')
        return { ok: true, text: 'done after tools', tool_calls: [], usage: { tokens: 10 } }
      return { ok: true, text: 'hi there', tool_calls: [], usage: { tokens: 5 } }
    },
    'guard.judge': (args) => {
      const calls = Array.isArray(args.calls) ? args.calls : []
      const decisions = calls.map((call, index) => ({
        index,
        port: call.port ?? '',
        tool: call.tool ?? '',
        verdict: 'allow',
      }))
      return { decisions, summary: { allow: decisions.length, escalate: 0, deny: 0 } }
    },
    'approval.enqueue': () => ({
      $directives: [
        {
          kind: 'write',
          request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: { id: 'ap-1' } } }] } },
        },
        { kind: 'extern', payload: { ok: true, id: 'ap-1', count: 1, pending: 1 } },
      ],
    }),
    'tools.dispatch': (args) => {
      const calls = Array.isArray(args.calls) ? args.calls : []
      return {
        results: calls.map((call, index) => ({
          call_id: call.call_id ?? `call-${index}`,
          ok: true,
          result: { tool: call.tool },
        })),
      }
    },
    'session.step_append': () => ({ ok: true, turn_id: 't1', deduped: false }),
    'session.turn_settle': (args) => ({
      ok: true,
      turn_id: args.turn_id,
      outcome: args.outcome,
      persisted: true,
    }),
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

/**
 * 启动完整门面链（loop-policy + graph-run + turn-ledger + graph-gate）并返回请求接口。
 * `providers` 覆盖节点能力类应答；`pins` 注入各服务的有效 pins；`env` 为帧 env。
 */
export function startService({ providers = {}, env = FIXED_ENV, pins = DEFAULT_PINS } = {}) {
  const resolvedProviders = { ...defaultProviders(), ...providers }
  const stepStore = new Map()
  const portCalls = []
  // 帧 env 传递：生产宿主按「在途调用」把 env 回带进反向调用帧；测试桥在此模拟同一语义，
  // 使 graph-run 内的 `env.now` 等于门面本次 interpret 调用的 env.now。
  let activeEnv = env

  function recordStep(message) {
    if (
      message.port === 'session' &&
      message.method === 'step_append' &&
      message.args &&
      typeof message.args.turn_id === 'string'
    ) {
      const list = stepStore.get(message.args.turn_id) ?? []
      list.push(message.args)
      stepStore.set(message.args.turn_id, list)
    }
  }

  /** 假节点提供者应答（也记录回合步记录）。 */
  function answerProvider(message) {
    recordStep(message)
    const key = `${message.port}.${message.method}`
    const provider = resolvedProviders[key]
    if (provider === undefined) {
      return { ok: false, code: 'unresolved_cap', message: key }
    }
    return Promise.resolve(provider(message.args ?? {}, message)).then((value) => {
      if (value && typeof value === 'object' && value.__error) return { ok: false, ...value.__error }
      return { ok: true, value: value ?? null }
    })
  }

  const spawnEnv = { ...process.env, CHRONO_PLUGIN_PINS: JSON.stringify(pins) }

  const graphGate = startBridgedService({
    cwd: join(PLUGINS_ROOT, 'graph-gate'),
    entry: join(PLUGINS_ROOT, 'graph-gate', 'execute', 'main.ts'),
    env: spawnEnv,
    timeoutMs: 20000,
    onPortCall: (message) => {
      portCalls.push(message)
      return { ok: true, value: null }
    },
  })

  const forwardGraphGate = (message) =>
    graphGate.call(message.port, message.method, message.args, message.env).then(relayFrame)

  const turnLedger = startBridgedService({
    cwd: join(PLUGINS_ROOT, 'turn-ledger'),
    entry: join(PLUGINS_ROOT, 'turn-ledger', 'execute', 'main.ts'),
    env: spawnEnv,
    timeoutMs: 20000,
    onPortCall: (message) => {
      portCalls.push(message)
      return message.port === 'graph-gate' ? forwardGraphGate(message) : answerProvider(message)
    },
  })

  const graphRun = startBridgedService({
    cwd: join(PLUGINS_ROOT, 'graph-run'),
    entry: join(PLUGINS_ROOT, 'graph-run', 'execute', 'main.ts'),
    env: spawnEnv,
    timeoutMs: 20000,
    onPortCall: (message) => {
      portCalls.push(message)
      return message.port === 'graph-gate' ? forwardGraphGate(message) : answerProvider(message)
    },
  })

  const loop = startBridgedService({
    cwd: PKG_ROOT,
    entry: join(PKG_ROOT, 'execute', 'main.ts'),
    env,
    timeoutMs: 20000,
    onPortCall: (message) => {
      // 门面对 graph-run / turn-ledger 的内部委派不计入端口序（观测口径与拆分前一致）。
      if (message.port !== 'graph-run' && message.port !== 'turn-ledger') portCalls.push(message)
      if (message.port === 'graph-run')
        return graphRun
          .call(message.port, message.method, message.args, message.env ?? activeEnv)
          .then(relayFrame)
      if (message.port === 'turn-ledger')
        return turnLedger
          .call(message.port, message.method, message.args, message.env ?? activeEnv)
          .then(relayFrame)
      if (message.port === 'graph-gate') return forwardGraphGate(message)
      return answerProvider(message)
    },
  })

  const services = [loop, graphRun, turnLedger, graphGate]

  async function interpretTurn(initial, callEnv) {
    // item 9：生产默认不再下传 `extra_messages`；测试驱动显式 opt-in 以沿用旧的同回合上下文回灌口径。
    activeEnv = callEnv ?? env
    let current = { ...initial, compat_extra_messages: true }
    const merged = []
    let last = null
    for (let guard = 0; guard < 500; guard += 1) {
      last = await loop.request(
        'call',
        { port: 'loop-policy', method: 'interpret', args: current, env: callEnv },
        ['result', 'error'],
      )
      if (last.kind !== 'result') return last
      const dirs = directivesOf(last.value)
      const cont = dirs.find(
        (item) =>
          item &&
          item.kind === 'eval' &&
          item.command === 'chat.resume' &&
          item.args &&
          typeof item.args.turn_id === 'string',
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
    const value =
      last.value && typeof last.value === 'object' && !Array.isArray(last.value) ? last.value : {}
    return { ...last, value: { ...value, $directives: [...merged, ...directivesOf(value)] } }
  }

  return {
    portCalls,
    get events() {
      return [...loop.events, ...graphRun.events, ...turnLedger.events, ...graphGate.events]
    },
    get stderr() {
      return [...loop.stderr, ...graphRun.stderr, ...turnLedger.stderr, ...graphGate.stderr]
    },
    get child() {
      return loop.child
    },
    request: (kind, fields, expect) => loop.request(kind, fields, expect),
    hello: () => loop.hello('loop-policy', 'gen-1'),
    call: (port, method, args, callEnv = env) => {
      activeEnv = callEnv
      return loop.request('call', { port, method, args, env: callEnv }, ['result', 'error'])
    },
    interpret: (bag, callEnv = env) => interpretTurn(bag, callEnv),
    close: () => {
      for (const service of services) service.close()
    },
    exit: Promise.all(services.map((service) => service.exit)).then(() => 0),
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
    if (
      directive.kind === 'write' &&
      directive.request?.args &&
      Array.isArray(directive.request.args.ops)
    ) {
      batches.push(directive.request.args.ops)
    }
  }
  return batches
}
