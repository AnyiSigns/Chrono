// 方法分发表：args 形态门禁 + 命名空间参数拒绝，然后派给存储引擎。
// 命名空间一律取调用帧 `env.emitter`；调用方自报的 namespace / owner / db 等参数可伪造，直接拒。

import { BadArgsError } from 'plugin-sdk'
import { StoreError } from './types.ts'
import { KvEngine, resolveOwner } from './engine.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

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

/** 方法名 → 引擎调用。每个方法先过共同门禁，再按 owner 分目录。 */
export function createHandlers(engine: KvEngine): Record<string, Handler> {
  const invoke = (method: string) => (args: Json, env: CallEnv): HandlerResult => {
    if (!isRec(args)) throw new BadArgsError('args must be an object')
    rejectNamespaceArgs(args)
    const owner = resolveOwner(env.emitter)
    switch (method) {
      case 'get':
        return { value: engine.get(owner, args), events: [] }
      case 'put':
        return { value: engine.put(owner, args), events: [] }
      case 'delete':
        return { value: engine.delete(owner, args), events: [] }
      case 'list':
        return { value: engine.list(owner, args), events: [] }
      case 'batch':
        return { value: engine.batch(owner, args), events: [] }
      case 'info':
        return { value: engine.info(owner), events: [] }
      case 'dropNamespace':
        return { value: engine.dropNamespace(owner), events: [] }
      default:
        throw new StoreError('unknown_method', method)
    }
  }
  const handlers: Record<string, Handler> = {}
  for (const method of ['get', 'put', 'delete', 'list', 'batch', 'info', 'dropNamespace']) {
    handlers[method] = invoke(method)
  }
  return handlers
}
