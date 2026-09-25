// `todo` 协议级测试的共享驱动与工具：自实现最小帧协议，spawn `node execute/main.ts`。
// 服务把清单读写委托给 storage-kv（反向 `port.call`）；驱动桥接一个按 emitter 分命名空间的内存假后端。
// 只服务测试（文件名不含 .test，不被 node --test 当用例收集）。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
export const AT = '2023-11-14T22:13:20.000Z'

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
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

/** 内存假 storage-kv：按 emitter 分命名空间；方法面与 storage-kv 一致。 */
export function createFakeStorage() {
  const namespaces = new Map()
  function namespaceOf(emitter) {
    const key = typeof emitter === 'string' && emitter.length > 0 ? emitter : '(null)'
    let store = namespaces.get(key)
    if (store === undefined) {
      store = new Map()
      namespaces.set(key, store)
    }
    return store
  }
  return {
    namespaces,
    call(emitter, method, args) {
      const store = namespaceOf(emitter)
      const record = args !== null && typeof args === 'object' ? args : {}
      switch (method) {
        case 'get': {
          const key = record.key
          return { found: store.has(key), value: store.get(key) ?? null }
        }
        case 'put': {
          store.set(record.key, record.value)
          return { ok: true, seq: store.size }
        }
        case 'delete':
          return { deleted: store.delete(record.key) }
        case 'batch': {
          const ops = Array.isArray(record.ops) ? record.ops : []
          for (const op of ops) {
            if (op.op === 'del') store.delete(op.key)
            else store.set(op.key, op.value)
          }
          return { ok: true, count: ops.length }
        }
        case 'list': {
          const prefix = typeof record.prefix === 'string' ? record.prefix : ''
          const entries = [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, value]) => ({ key, value }))
          return { entries }
        }
        case 'info':
          return { schemaVersion: 1, entries: store.size }
        case 'dropNamespace':
          return { dropped: namespaces.delete(typeof emitter === 'string' ? emitter : '(null)') }
        default:
          return undefined
      }
    },
  }
}

export function startService(options = {}) {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const storage = options.storage ?? createFakeStorage()
  const emitter = options.emitter ?? 'todo'
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  function respond(message) {
    child.stdin.write(encodeFrame(message))
  }

  function handlePortCall(message) {
    portCalls.push({ port: message.port, method: message.method, args: message.args })
    if (typeof options.fault === 'function') {
      const fault = options.fault(message.method, message.args)
      if (fault !== null && fault !== undefined) {
        respond({ v: '1', id: message.id, kind: 'port.error', ok: false, error: fault.code, message: fault.message })
        return
      }
    }
    const outcome = storage.call(emitter, message.method, message.args)
    if (outcome === undefined) {
      respond({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'unknown_method', message: message.method })
      return
    }
    respond({ v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome })
  }

  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'port.call') {
        handlePortCall(message)
        continue
      }
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    events,
    exit,
    portCalls,
    storage,
    request,
    async hello() {
      return request('hello', { impl: 'todo', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args, env = FIXED_ENV) {
      const message = await request('call', { port: 'todo', method, args, env }, 'result')
      return message.value
    },
    async callRaw(method, args, env = FIXED_ENV) {
      return request('call', { port: 'todo', method, args, env }, ['result', 'error'])
    },
    /** 向任意能力类发一次调用（测未知能力类）。 */
    async callPort(port, method, args, env = FIXED_ENV) {
      return request('call', { port, method, args, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}

/** 断言一次调用未产出世界写计划（运行记录已出世界）。 */
export function assertNoDirectives(value) {
  assert.equal(value.$directives, undefined, 'runtime record must not produce world directives')
}
