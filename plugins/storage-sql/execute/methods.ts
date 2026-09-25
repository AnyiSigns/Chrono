// 方法分发表：args 形态门禁 + 命名空间参数拒绝 + 载荷上限，然后派给存储引擎。
// 命名空间一律取调用帧 `env.emitter`；调用方自报的 namespace / owner / db 等参数可伪造，直接拒。

import { BadArgsError, StoreError } from './types.ts'
import { MAX_PAYLOAD_BYTES, resolveOwner, SqlEngine } from './engine.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

/** 调用方不得自报命名空间：这些键出现即拒，而不是静默忽略。 */
const FORBIDDEN_NAMESPACE_KEYS = ['namespace', 'ns', 'owner', 'emitter', 'database', 'db', 'path']

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectNamespaceArgs(args: Rec): void {
  for (const key of FORBIDDEN_NAMESPACE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new BadArgsError(`namespace is derived from env.emitter; args.${key} is rejected`)
    }
  }
}

function enforcePayloadLimit(args: Json): void {
  const bytes = Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8')
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new StoreError(
      'payload_too_large',
      `payload ${bytes} bytes exceeds ${MAX_PAYLOAD_BYTES}; store bytes via host.asset and pass the reference`,
    )
  }
}

/** 方法名 → 引擎调用。每个方法先过共同门禁，再按 owner 分库。 */
export function createHandlers(engine: SqlEngine): Record<string, Handler> {
  const invoke = (method: string) => (args: Json, env: CallEnv): HandlerResult => {
    if (!isRec(args)) throw new BadArgsError('args must be an object')
    rejectNamespaceArgs(args)
    enforcePayloadLimit(args)
    const owner = resolveOwner(env.emitter)
    switch (method) {
      case 'createTable':
        return { value: engine.createTable(owner, args) }
      case 'query':
        return { value: engine.query(owner, args) }
      case 'write':
        return { value: engine.write(owner, args) }
      case 'batch':
        return { value: engine.batch(owner, args) }
      case 'listTables':
        return { value: engine.listTables(owner) }
      case 'info':
        return { value: engine.info(owner) }
      case 'dropNamespace':
        return { value: engine.dropNamespace(owner) }
      default:
        throw new StoreError('unknown_method', method)
    }
  }
  const handlers: Record<string, Handler> = {}
  for (const method of ['createTable', 'query', 'write', 'batch', 'listTables', 'info', 'dropNamespace']) {
    handlers[method] = invoke(method)
  }
  return handlers
}
