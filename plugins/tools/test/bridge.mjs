// 本地异步服务驱动：spawn 一个真实插件服务进程，并**异步**应答其反向 `port.call`。
// 插件测试不得 import 兄弟插件源码，故跨插件联调只能经本驱动 spawn 进程 + 帧转发完成；
// `onPortCall` 允许返回 Promise，因而可把一次反向调用再转发给另一个真实服务进程（多跳桥）。
// 本文件只导出驱动工具、不含用例；Node 默认测试收集会把它当作空测试文件载入（无副作用）。

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createFrameDecoder, encodeFrame, SERVICE_PROTOCOL_VERSION } from 'plugin-sdk'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 由插件包根推服务入口。 */
export function serviceEntry(cwd) {
  return join(cwd, 'execute', 'main.ts')
}

/** 把 `call` 回帧（result / error）规范成路由应答。 */
export function relayFrame(frame) {
  if (frame.kind === 'error') return { ok: false, code: frame.error, message: frame.message ?? '' }
  return { ok: true, value: frame.value ?? null }
}

/**
 * spawn 一个真实插件服务并返回请求接口；`onPortCall(message)` 可返回应答或 Promise<应答>，
 * 应答形如 `{ok:true,value}` / `{ok:false,code,message}`，缺省 `{ok:true,value:null}`。
 */
export function startBridgedService(options) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const child = spawn(process.execPath, [options.entry], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const decoder = createFrameDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const stderr = []
  const timeoutMs = options.timeoutMs ?? 15000
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  function respond(message, response) {
    const base = {
      v: SERVICE_PROTOCOL_VERSION,
      id: typeof message.id === 'string' ? message.id : '',
    }
    if (response !== null && response !== undefined && response.ok === true) {
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

  child.stdout?.on('data', (chunk) => {
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
            respond(message, {
              ok: false,
              code: 'internal',
              message: String(err?.message ?? err),
            }),
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
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `brg-${seq}`
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
          rejectRequest(new Error(`expected ${expected.join('/')} got ${String(message.kind)}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields }))
    })
  }

  return {
    child,
    events,
    portCalls,
    stderr,
    exit,
    request,
    call(port, method, args, callEnv) {
      const fields = { port, method, args }
      if (callEnv !== undefined) fields.env = callEnv
      return request('call', fields, ['result', 'error'])
    },
    hello(impl, gen = 'gen-1') {
      return request('hello', { impl, gen }, 'manifest')
    },
    close() {
      try {
        child.stdin.end()
      } catch {
        // 已关闭
      }
    },
  }
}
