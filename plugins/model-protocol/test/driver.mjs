// 协议级测试驱动：基于 SDK 测试驱动 spawn `node execute/main.ts`，发 hello / call / 控制帧，收集 event，
// 并自动应答反向调用 `port.call`（模拟宿主侧路由）。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 启动服务并返回请求 / 事件接口；`secretsResolver(port, method, args)` 应答反向调用。 */
export function startService(options = {}) {
  // 默认应答：secrets 端口不可用；config 端口写成功、读不可用（sync 回落 bag.config）。
  const secretsResolver =
    options.secretsResolver ??
    ((port, method) => {
      if (port === 'config') {
        if (method === 'write') return { value: { ok: true, changed: true } }
        return { error: 'not_available', message: 'no config owner in test' }
      }
      return { error: 'secret_missing', message: 'no resolver' }
    })
  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    env: { CHRONO_PLUGIN_STATE: '', ...(options.env ?? {}) },
    timeoutMs: 10000,
    onPortCall: (message) => {
      const outcome = secretsResolver(message.port, message.method, message.args)
      if (outcome.error) return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      return { ok: true, value: outcome.value }
    },
  })
  return {
    ...drv,
    hello: () => drv.hello('model-protocol'),
    call: (method, args, env = FIXED_ENV) => drv.call('model', method, args, env),
  }
}

/** 一个最小 config（连接实例）。 */
export function configFor(serverUrl, overrides = {}) {
  return {
    base_url: serverUrl,
    model: 'test-model',
    params: { temperature: 0.2, max_tokens: 64, reasoning: 'low' },
    quirks: {
      impl: 'protocol',
      protocol: 'openai-chat',
      auth_style: 'bearer',
      system_role: 'system',
      reasoning_field: 'reasoning_effort',
      reasoning_map: { low: 'low', medium: 'medium', high: 'high' },
      reasoning_response_field: 'reasoning_content',
      max_tokens_field: 'max_tokens',
      models_path: '/models',
      stream_usage: 'final_chunk',
      extra_headers: {},
    },
    ...overrides,
  }
}

export function chatBag(serverUrl, overrides = {}) {
  const { config, messages, ...rest } = overrides
  return {
    config: configFor(serverUrl, config),
    messages: messages ?? [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
    ...rest,
  }
}
