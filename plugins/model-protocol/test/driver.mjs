// 协议级测试驱动：spawn `node execute/main.ts`，发 hello / call / 控制帧，收集 event，
// 并**异步**应答反向调用 `port.call`：`throttle` 与 `msg-dialect` 经 `plugin-sdk` 驱动 spawn 各自
// **真实服务进程**应答（不 import 兄弟插件源码），其余端口（secrets / config / host）经 `secretsResolver` 模拟。
// 说明：SDK `startService` 的反向调用应答是同步的，而 `msg-dialect.inline-assets` 需 await 取字节，
// 故本驱动自持 spawn + 帧编解码 + 异步 port bridge（API 与 SDK 驱动同形，供接缝契约复用）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  createFrameDecoder,
  encodeFrame,
  SERVICE_PROTOCOL_VERSION,
  startService as startPluginService,
} from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const THROTTLE_ROOT = resolve(PKG_ROOT, '..', 'throttle')
const MSG_DIALECT_ROOT = resolve(PKG_ROOT, '..', 'msg-dialect')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function isRecordMessage(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 缺省 secrets / config / host 解析：config.write 恒成功，其余报缺。 */
function defaultSecretsResolver(port, method) {
  if (port === 'config') {
    if (method === 'write') return { value: { ok: true, changed: true } }
    return { error: 'not_available', message: 'no config owner in test' }
  }
  return { error: 'secret_missing', message: 'no resolver' }
}

function portResponse(id, response) {
  if (response.ok) {
    return {
      v: SERVICE_PROTOCOL_VERSION,
      id: typeof id === 'string' ? id : '',
      kind: 'port.result',
      ok: true,
      value: response.value ?? null,
    }
  }
  return {
    v: SERVICE_PROTOCOL_VERSION,
    id: typeof id === 'string' ? id : '',
    kind: 'port.error',
    ok: false,
    error: response.code ?? 'port_failed',
    message: response.message ?? '',
  }
}

/** 把下游服务的 `call` 回帧（result / error）规范成 port bridge 应答。 */
function relayFrame(frame) {
  if (frame.kind === 'error')
    return { ok: false, code: frame.error ?? 'port_failed', message: frame.message ?? '' }
  return { ok: true, value: frame.value ?? null }
}

/** `throttle` 真实提供方：spawn 服务进程，`acquire` / `plan` / `penalize` / `policy` 经帧转发。 */
function createThrottle(timeoutMs, env) {
  const child = startPluginService({
    entry: join(THROTTLE_ROOT, 'execute', 'main.ts'),
    cwd: THROTTLE_ROOT,
    timeoutMs,
    env: { CHRONO_PLUGIN_STATE: '', ...(env ?? {}) },
  })
  return {
    call: (method, args, callEnv) => child.call('throttle', method, args, callEnv ?? FIXED_ENV),
    exit: child.exit,
    close: () => child.close(),
  }
}

/** `msg-dialect` 真实提供方：spawn 服务进程；其 `host.asset.get` 经 `secretsResolver` 同步应答。 */
function createDialect(secretsResolver, timeoutMs, env) {
  const child = startPluginService({
    entry: join(MSG_DIALECT_ROOT, 'execute', 'main.ts'),
    cwd: MSG_DIALECT_ROOT,
    timeoutMs,
    env: { CHRONO_PLUGIN_STATE: '', ...(env ?? {}) },
    onPortCall: (message) => {
      const outcome = secretsResolver(message.port, message.method, message.args)
      if (outcome.error)
        return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      return { ok: true, value: outcome.value }
    },
  })
  async function invoke(method, args) {
    const frame = await child.call('msg-dialect', method, args, FIXED_ENV)
    if (frame.kind !== 'result')
      throw new Error(`msg-dialect.${method} failed: ${frame.error ?? frame.code}`)
    return frame.value
  }
  return {
    call: (method, args, callEnv) => child.call('msg-dialect', method, args, callEnv ?? FIXED_ENV),
    exit: child.exit,
    close: () => child.close(),
    async normalizeQuirks(raw, override) {
      const value = await invoke('normalize-quirks', {
        quirks: raw ?? null,
        protocol_override: override ?? null,
      })
      return value.quirks
    },
    build: (args) => invoke('build', args),
  }
}

/** 起一个独立的 `msg-dialect` 真实服务（供只测方言编形的用例直接调用）。 */
export function startDialect(options = {}) {
  return createDialect(
    options.secretsResolver ?? defaultSecretsResolver,
    options.timeoutMs ?? 10000,
    options.env,
  )
}

/** 启动服务并返回请求 / 事件接口；`secretsResolver(port, method, args)` 应答 secrets / config / host。 */
export function startService(options = {}) {
  const secretsResolver = options.secretsResolver ?? defaultSecretsResolver
  const timeoutMs = options.timeoutMs ?? 10000
  const throttle = createThrottle(timeoutMs, options.env)
  const dialect = createDialect(secretsResolver, timeoutMs, options.env)

  const env = { ...process.env, CHRONO_PLUGIN_STATE: '', ...(options.env ?? {}) }
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const decoder = createFrameDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const exit = new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit(code))
  })

  // 下游真实提供方经 spawn 桥应答（不 import 兄弟插件源码）；其余端口走 secretsResolver。
  const onPortCall = async (message) => {
    if (message.port === 'throttle')
      return relayFrame(await throttle.call(message.method, message.args ?? {}, message.env))
    if (message.port === 'msg-dialect')
      return relayFrame(await dialect.call(message.method, message.args ?? {}, message.env))
    const outcome = secretsResolver(message.port, message.method, message.args)
    if (outcome.error)
      return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
    return { ok: true, value: outcome.value }
  }

  child.stdout?.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (!isRecordMessage(message)) continue
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve(onPortCall(message)).then(
          (response) => child.stdin?.write(encodeFrame(portResponse(message.id, response))),
          (err) =>
            child.stdin?.write(
              encodeFrame(
                portResponse(message.id, {
                  ok: false,
                  code: 'port_failed',
                  message: String(err?.message ?? err),
                }),
              ),
            ),
        )
        continue
      }
      const handler = typeof message.id === 'string' ? pending.get(message.id) : undefined
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr?.on('data', () => {})

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${String(message.kind)}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin?.write(encodeFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields }))
    })
  }

  return {
    child,
    events,
    portCalls,
    exit,
    request,
    dialect,
    call(method, args, env2 = FIXED_ENV) {
      return request('call', { port: 'model', method, args, env: env2 }, ['result', 'error'])
    },
    hello(impl = 'model-protocol', gen = 'gen-1') {
      return request('hello', { impl, gen }, 'manifest')
    },
    close() {
      child.stdin?.end()
      throttle.close()
      dialect.close()
    },
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
