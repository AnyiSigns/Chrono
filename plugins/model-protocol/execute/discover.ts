// discover：`{url, auth_ref}` -> GET `{base_url}{models_path}` + 鉴权 -> 规范化模型 id 列表。
// 结构化错误：discover_auth_failed / discover_bad_url / discover_unsupported / discover_network。

import { ModelError } from './errors.ts'
import { httpRequest } from './http.ts'
import { isRecord } from './plan.ts'
import { authRefOf } from './port-link.ts'
import type { PortLink } from './port-link.ts'
import { applyAuth, joinUrl, normalizeQuirks } from './quirks.ts'
import { resolvePolicy, withRetry } from './resilience.ts'
import type { RateLimiter } from './resilience.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json } from './types.ts'

export interface DiscoverDeps {
  secrets: PortLink
  limiter: RateLimiter
}

function discoverClassify(status: number): Error {
  if (status === 401 || status === 403) return new ModelError('discover_auth_failed', `http ${status}`)
  if (status === 404) return new ModelError('discover_bad_url', `http ${status}`)
  return new ModelError('discover_unsupported', `http ${status}`)
}

/** 把网络 / 超时错误重映射为 discover_network；其余原样。 */
function remap(err: Error): Error {
  if (err instanceof ModelError && (err.code === 'model_network_error' || err.code === 'model_timeout')) {
    return new ModelError('discover_network', err.message, { retryable: true })
  }
  return err
}

/** 从各种厂商回包里抽出模型 id 列表：剥 `models/` 前缀、去重、排序。 */
export function normalizeModelIds(json: Json): string[] {
  const candidates = collectCandidates(json)
  const ids = new Set<string>()
  for (const candidate of candidates) {
    const record = isRecord(candidate) ? candidate : null
    const raw = record === null ? candidate : record['id'] ?? record['name'] ?? record['model']
    if (typeof raw !== 'string' || raw.length === 0) continue
    ids.add(raw.replace(/^models\//, ''))
  }
  return [...ids].sort()
}

function collectCandidates(json: Json): Json[] {
  if (Array.isArray(json)) return json
  if (!isRecord(json)) return []
  for (const key of ['data', 'models', 'items', 'model']) {
    const value = json[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/** URL 形态校验：非法 base_url / models_path 归 `discover_bad_url`，不让 `new URL` 冒泡成 internal。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 规范化模型 id 列表；错误以结构化码回灌（不抛协议错）。 */
export async function discover(args: Json, env: CallEnv, deps: DiscoverDeps): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const url = args['url']
  if (typeof url !== 'string' || url.length === 0) throw new BadArgsError('url required')
  const protocol = typeof args['protocol'] === 'string' ? (args['protocol'] as string) : 'openai-chat'
  const quirks = normalizeQuirks({}, protocol)
  const modelsPath = typeof args['models_path'] === 'string' ? (args['models_path'] as string) : quirks.models_path
  const policy = resolvePolicy(args['resilience'])
  const authRef = authRefOf(args)

  try {
    let secret: string | null = null
    if (authRef !== null) {
      const outcome = await deps.secrets.call('secrets', 'resolve', { auth_ref: authRef })
      if (!outcome.ok) return { ok: false, error: { code: 'discover_auth_failed', message: `secret resolve failed: ${outcome.code}` } }
      secret = typeof outcome.value === 'string' ? outcome.value : null
    }
    const targetUrl = joinUrl(url, modelsPath)
    if (!isHttpUrl(targetUrl)) {
      return { ok: false, error: { code: 'discover_bad_url', message: `invalid url: ${targetUrl}` } }
    }
    const auth = applyAuth(targetUrl, quirks, secret)
    const response = await withRetry(
      url,
      async () => {
        try {
          return await httpRequest({
            method: 'GET',
            url: auth.url,
            headers: { accept: 'application/json', ...auth.headers },
            timeout_ms: policy.request_timeout_ms,
            now: env.now,
            classify: (status) => discoverClassify(status),
          })
        } catch (err) {
          throw remap(err as Error)
        }
      },
      { policy, limiter: deps.limiter, now: env.now },
    )
    let json: Json
    try {
      json = JSON.parse(response.body) as Json
    } catch {
      return { ok: false, error: { code: 'discover_unsupported', message: 'response is not JSON' } }
    }
    const models = normalizeModelIds(json)
    if (models.length === 0) {
      return { ok: false, error: { code: 'discover_unsupported', message: 'no model list in response' } }
    }
    return { ok: true, models }
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return { ok: false, error: { code: err.code, message: err.message } }
    throw err
  }
}
