// 接缝契约测试的共享驱动：spawn 一个真实插件服务，异步路由其反向调用 `port.call`。
// 与 `plugin-sdk/driver.ts` 的区别：`onPortCall` 允许返回 Promise，故可把一次反向调用转发给
// 另一个真实服务（跨插件联调），而不是只回确定性假值。夹具与断言器仍住 chain-contract。
//
// 本文件不是测试文件（不以 .test.mjs 结尾），不参与 `node --test` 收集。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFrameDecoder, encodeFrame, SERVICE_PROTOCOL_VERSION } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')

/** 插件服务的入口模块与工作目录。 */
export function pluginEntry(name) {
  const cwd = join(REPO_ROOT, 'plugins', name)
  return { cwd, entry: join(cwd, 'execute', 'main.ts') }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 启动一个真实插件服务。
 * @param {object} options
 * @param {string} options.name 插件名（如 `loop-policy`）
 * @param {Record<string,string>} [options.env] 追加环境变量
 * @param {(message: object) => object | Promise<object>} [options.onPortCall] 反向调用应答；
 *   回 `{ok:true,value}` / `{ok:false,code,message}`；缺省 `{ok:true,value:null}`
 * @param {number} [options.timeoutMs] 单请求等待上限，缺省 20000ms
 */
export function startRealService(options) {
  const { cwd, entry } = pluginEntry(options.name)
  if (!existsSync(entry)) throw new Error(`service entry not found: ${entry}`)
  const env = { ...process.env, ...(options.env ?? {}) }
  const child = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createFrameDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const timeoutMs = options.timeoutMs ?? 20000
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  function respond(message, response) {
    const base = {
      v: SERVICE_PROTOCOL_VERSION,
      id: typeof message.id === 'string' ? message.id : '',
    }
    if (response !== null && response.ok === true) {
      child.stdin.write(
        encodeFrame({ ...base, kind: 'port.result', value: response.value ?? null }),
      )
      return
    }
    child.stdin.write(
      encodeFrame({
        ...base,
        kind: 'port.error',
        error: (response && response.code) || 'port_failed',
        message: (response && response.message) || '',
      }),
    )
  }

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (!isRecord(message)) continue
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        Promise.resolve(
          options.onPortCall ? options.onPortCall(message) : { ok: true, value: null },
        )
          .then((response) => respond(message, response ?? { ok: true, value: null }))
          .catch((err) =>
            respond(message, { ok: false, code: 'internal', message: String(err && err.message) }),
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
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `seam-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(
          new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr.join('')}`),
        )
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(
            new Error(
              `expected ${expected.join('/')} got ${message.kind}: ${JSON.stringify(message)}`,
            ),
          )
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields }))
    })
  }

  return {
    name: options.name,
    child,
    events,
    portCalls,
    stderr,
    exit,
    request,
    hello: () => request('hello', { impl: options.name, gen: 'gen-1' }, 'manifest'),
    call: (port, method, args, callEnv) =>
      request('call', { port, method, args, ...(callEnv === undefined ? {} : { env: callEnv }) }, [
        'result',
        'error',
      ]),
    close: () => child.stdin.end(),
  }
}

/** 默认调用帧 env（run / thread / now 固定，保证确定性）。 */
export const FIXED_ENV = { run: 'run-seam', thread: 't1', now: 1_700_000_000_000 }

/**
 * 由路由表构造 `onPortCall`：按 `<目标>.<method>` 精确匹配 → 按 `<目标>` 匹配 → `fallback`。
 * 目标 = 帧 `provider`（按成员定位的 many 目标提供方身份名）优先，否则帧 `port`（单值端口）。
 * 命中函数可回 `{ok,...}` 形态，也可直接回值（自动包成 `{ok:true,value}`）。
 */
export function makeRouter(routes, fallback) {
  return (message) => {
    const port = typeof message.provider === 'string' ? message.provider : message.port
    const method = message.method
    const fn = routes[`${port}.${method}`] ?? routes[port] ?? fallback
    if (fn === undefined) return { ok: false, code: 'unresolved_cap', message: `${port}.${method}` }
    return Promise.resolve(fn(message.args ?? {}, message)).then((value) => {
      if (isRecord(value) && typeof value.ok === 'boolean' && ('value' in value || 'code' in value))
        return value
      return { ok: true, value: value === undefined ? null : value }
    })
  }
}

/** 把 `call` 回帧（result / error）规范成路由应答。 */
export function relayFrame(frame) {
  if (frame.kind === 'error') return { ok: false, code: frame.error, message: frame.message ?? '' }
  return { ok: true, value: frame.value ?? null }
}

/**
 * 关闭服务并等它真正退出（stdin EOF 后自退；超时则强杀）。
 * Windows 上子进程仍持有物化目录里的原生库时 `rmSync` 会 EPERM，故必须先等退出再清理临时目录。
 */
export async function stopRealService(service, timeoutMs = 3000) {
  try {
    service.close()
  } catch {
    // 已退出
  }
  const exited = await Promise.race([
    service.exit.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
  if (!exited) {
    try {
      service.child.kill()
    } catch {
      // 已退出
    }
    await Promise.race([service.exit, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }
}

/** 调真实服务并把回帧转成路由应答。 */
export function forward(service) {
  return (args, message) =>
    service.call(message.port, message.method, args, message.env).then(relayFrame)
}
