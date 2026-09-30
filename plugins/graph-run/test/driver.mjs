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
    'tools.list': () => ({ tools: [], rejected: [] }),
    'tools.dispatch': (args) => ({
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
    ...overrides,
  }
}

/** 启动 graph-run 服务并回请求接口。 */
export function startService({ providers = {}, env = FIXED_ENV } = {}) {
  const resolved = defaultProviders(providers)
  const service = startBridgedService({
    cwd: PKG_ROOT,
    entry: join(PKG_ROOT, 'execute', 'main.ts'),
    env: { ...process.env, ...env },
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
