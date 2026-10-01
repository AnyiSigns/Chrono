// graph-run 协议级测试驱动：spawn 本插件服务，并把反向 `port.call`（节点能力类 / 机械闸）应答为假实现。
// 插件内不得 import 兄弟插件源码，故跨插件联调只在根 tests/contract；此处只驱动本插件自有方法。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startBridgedService } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 默认反向应答：机械闸闭合通过；节点能力类返回确定性值。 */
export function defaultProviders(overrides = {}) {
  return {
    'graph-gate.closure': () => ({ ok: true, errors: [], view: null }),
    'graph-gate.validate': () => ({ ok: true, errors: [], result_hash: 'a'.repeat(64) }),
    'model.chat': () => ({ ok: true, text: 'hi', tool_calls: [], usage: { tokens: 1 } }),
    'session.step_append': () => ({ ok: true, turn_id: 't1', deduped: false }),
    'tool-registry.list': () => ({ tools: [], rejected: [] }),
    'tool-dispatch.dispatch': (args) => ({
      results: (args.calls ?? []).map((call) => ({ call_id: call.call_id, ok: true, result: {} })),
    }),
    'guard.judge': (args) => ({
      decisions: (args.calls ?? []).map((call, index) => ({
        index,
        port: call.port ?? '',
        tool: call.tool ?? '',
        verdict: 'allow',
      })),
      summary: { allow: 1, escalate: 0, deny: 0 },
    }),
    'evolve-metrics.shadow': () => ({ status: 'pass', metric_id: 'metric-1' }),
    'router.select': (args) => args.primary,
    // 判据能力类 `loop-rule` 的桩：本插件单测只用到缺省 `always`；名未认领即 fail-closed。
    'loop-rule.when': (args) => ({ known: args.name === 'always', ok: true, value: true }),
    'loop-rule.pre': (args) => ({ known: args.name === 'always', ok: true }),
    'loop-rule.post': (args) => ({ known: args.name === 'always', ok: true }),
    // 回合固定点钩子桩：默认无中立增量（无需挂起 / 注入）。
    'turn-hook.before-assemble': () => ({ delta: {} }),
    'turn-hook.after-step': () => ({ delta: {} }),
    'turn-hook.before-settle': () => ({ delta: {} }),
    'turn-hook.after-settle': () => ({ delta: {} }),
    ...overrides,
  }
}

/** `many` 成员表：单测默认注入判据 / 钩子桩成员，场景 env 可覆盖或追加。 */
const BASE_MANY_NEEDS = {
  'loop-rule': ['loop-rule-stub'],
  'turn-hook': ['turn-hook-stub'],
}

function withManyNeeds(env) {
  const raw = env['CHRONO_PLUGIN_MANY_NEEDS']
  let parsed = {}
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = {}
    }
  }
  return { ...env, CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify({ ...BASE_MANY_NEEDS, ...parsed }) }
}

/** 启动 graph-run 服务并回请求接口。 */
export function startService({ providers = {}, env = FIXED_ENV } = {}) {
  const resolved = defaultProviders(providers)
  const service = startBridgedService({
    cwd: PKG_ROOT,
    entry: join(PKG_ROOT, 'execute', 'main.ts'),
    env: { ...process.env, ...withManyNeeds(env) },
    timeoutMs: 20000,
    onPortCall: (message) => {
      const key = `${message.port}.${message.method}`
      const provider = resolved[key]
      if (provider === undefined) return { ok: false, code: 'unresolved_cap', message: key }
      return Promise.resolve(provider(message.args ?? {}, message)).then((value) => ({
        ok: true,
        value: value ?? null,
      }))
    },
  })
  return {
    service,
    request: (kind, fields, expect) => service.request(kind, fields, expect),
    hello: () => service.hello('graph-run', 'gen-1'),
    run: (args, callEnv = env) =>
      service.request('call', { port: 'graph-run', method: 'run', args, env: callEnv }, ['result', 'error']),
    cancel: (args, callEnv = env) =>
      service.request('call', { port: 'graph-run', method: 'cancel', args, env: callEnv }, ['result', 'error']),
    close: () => service.close(),
    exit: service.exit,
  }
}
