// 方法分发表：args 形态门禁 + 命名空间解析（取调用帧 env.emitter），然后派给索引引擎。
// 调用方自报的 namespace / owner / db 等参数可伪造，直接拒。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { IndexError } from './types.ts'
import type { IndexDocument, IndexEngine } from './engine.ts'
import type { CallEnv, Handler, Json, Rec } from 'plugin-sdk'

/** owner 名 = 调用方身份名，宿主已保证安全单段；此处再校验一遍，避免自造文件路径。 */
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 调用方不得自报命名空间：这些键出现即拒，而不是静默忽略。 */
const FORBIDDEN_NAMESPACE_KEYS = ['namespace', 'ns', 'owner', 'emitter', 'database', 'db', 'path']

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

function resolveOwner(emitter: Json): string {
  const owner = typeof emitter === 'string' && emitter.length > 0 ? emitter : 'search-index'
  if (owner.length > 128 || owner === '.' || owner === '..' || !OWNER_NAME.test(owner)) {
    throw new BadArgsError(`unsafe emitter name: ${owner}`)
  }
  return owner
}

function rejectNamespaceArgs(args: Rec): void {
  for (const key of FORBIDDEN_NAMESPACE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new BadArgsError(`namespace is derived from env.emitter; args.${key} is rejected`)
    }
  }
}

function asString(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

function parseSearch(args: Rec): { query: string; limit: number } {
  const query = args['query']
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new BadArgsError('query must be a non-empty string')
  }
  const rawLimit = args['limit']
  if (rawLimit === undefined) return { query, limit: DEFAULT_LIMIT }
  if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new BadArgsError('limit must be a positive integer')
  }
  return { query, limit: Math.min(rawLimit, MAX_LIMIT) }
}

function parseDocuments(args: Rec): IndexDocument[] {
  const documents = args['documents']
  if (!Array.isArray(documents)) throw new BadArgsError('documents must be an array')
  const out: IndexDocument[] = []
  for (const item of documents) {
    if (!isRecord(item)) continue
    const url = asString(item['url'])
    if (url.length === 0) continue
    out.push({
      url,
      title: asString(item['title']),
      snippet: asString(item['snippet']),
      source: asString(item['source']),
      body: asString(item['body']),
    })
  }
  return out
}

/** 方法名 → 引擎调用。每个方法先过共同门禁，再按 owner 分命名空间。 */
export function createHandlers(engine: IndexEngine): Record<string, Handler> {
  const invoke = (method: string) => (args: Json, env: CallEnv) => {
    if (!isRecord(args)) throw new BadArgsError('args must be an object')
    rejectNamespaceArgs(args)
    const owner = resolveOwner(env.emitter)
    switch (method) {
      case 'search': {
        const { query, limit } = parseSearch(args)
        return { value: engine.search(owner, query, limit), events: [] }
      }
      case 'put':
        return { value: engine.put(owner, parseDocuments(args)), events: [] }
      case 'stats':
        return { value: engine.stats(owner), events: [] }
      default:
        throw new IndexError('unknown_method', method)
    }
  }
  const handlers: Record<string, Handler> = {}
  for (const method of ['search', 'put', 'stats']) handlers[method] = invoke(method)
  return handlers
}
