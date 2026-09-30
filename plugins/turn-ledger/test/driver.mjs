// turn-ledger 协议级测试驱动：spawn 本插件服务，并把反向 `port.call`（机械闸 / 影子回放 / 审批）应答为假实现。
// 插件内不得 import 兄弟插件源码，故跨插件联调只在根 tests/contract；此处只驱动本插件自有方法。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startBridgedService } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 默认反向应答：机械闸通过 / 影子指标 / 审批入队。 */
export function defaultProviders(overrides = {}) {
  return {
    'graph-gate.validate': () => ({ ok: true, errors: [], result_hash: 'a'.repeat(64) }),
    'evolve-metrics.shadow': () => ({ status: 'pass', metric_id: 'metric-1' }),
    'approval.enqueue': () => ({
      $directives: [
        {
          kind: 'write',
          request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: { id: 'ap-1' } } }] } },
        },
        { kind: 'extern', payload: { ok: true, id: 'ap-1' } },
      ],
    }),
    ...overrides,
  }
}

/** 启动 turn-ledger 服务并回请求接口。 */
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
    hello: () => service.hello('turn-ledger', 'gen-1'),
    call: (method, args, callEnv = env) =>
      service.request('call', { port: 'turn-ledger', method, args, env: callEnv }, ['result', 'error']),
    close: () => service.close(),
    exit: service.exit,
  }
}
