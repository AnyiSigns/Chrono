// `todo` 协议级测试的共享驱动与工具：基于 SDK 测试驱动 spawn `node execute/main.ts`。
// 服务把清单读写委托给 storage-kv（反向 `port.call`）；本文件桥接一个按 emitter 分命名空间的内存假后端。
// 只服务测试（文件名不含 .test，不被 node --test 当用例收集）。

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
export const AT = '2023-11-14T22:13:20.000Z'

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

/** SDK 驱动适配：能力类固定，反向调用桥接到内存假 storage。 */
export function startService(options = {}) {
  const storage = options.storage ?? createFakeStorage()
  const emitter = options.emitter ?? 'todo'
  const drv = startSdkService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      if (typeof options.fault === 'function') {
        const fault = options.fault(message.method, message.args)
        if (fault !== null && fault !== undefined) {
          return { ok: false, code: fault.code, message: fault.message }
        }
      }
      const outcome = storage.call(emitter, message.method, message.args)
      if (outcome === undefined) {
        return { ok: false, code: 'unknown_method', message: message.method }
      }
      return { ok: true, value: outcome }
    },
  })
  return {
    ...drv,
    storage,
    hello: () => drv.hello('todo'),
    async call(method, args, env = FIXED_ENV) {
      const message = await drv.call('todo', method, args, env)
      return message.value
    },
    callRaw: (method, args, env = FIXED_ENV) => drv.call('todo', method, args, env),
    callPort: (port, method, args, env = FIXED_ENV) => drv.call(port, method, args, env),
  }
}

/** 断言一次调用未产出世界写计划（运行记录已出世界）。 */
export function assertNoDirectives(value) {
  assert.equal(value.$directives, undefined, 'runtime record must not produce world directives')
}
