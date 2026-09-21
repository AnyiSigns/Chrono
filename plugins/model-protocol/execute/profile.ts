// profile / sync：拉 models.dev -> 只取所选模型 -> 产 config 身份的写计划（put 整份 body + add_gen）。
// 落盘前把社区布尔 true 展开为该 vendor 的 default_reasoning 数组（无则缺键）；写前去重（无变化不产写计划）。
// sync 由宿主 periodic 直接调，bag 由 schema.periodic.reads 机械注入；服务不读投影、不联网以外的世界。

import { ModelError, errorValue } from './errors.ts'
import { httpRequest } from './http.ts'
import { addGenOp, canonicalEqual, deepClone, externOnly, isRecord, planOf, putOp } from './plan.ts'
import { RateLimiter, resolvePolicy, withRetry } from './resilience.ts'
import type { RetryPolicy } from './resilience.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'
import { collectVendorBodies } from './vendors.ts'

export interface ProfileDeps {
  limiter: RateLimiter
}

const MANAGED_KEYS = ['context_window', 'max_output', 'reasoning', 'modalities'] as const

const PROVIDER_ALIASES: Record<string, string> = {
  'google-genai': 'google',
  dashscope: 'alibaba',
}

interface Target {
  vendor: string
  ids: string[]
}

function stripVendorPrefix(name: string): string {
  return name.replace(/^vendor-/, '')
}

/** models.dev 顶层可能是 `{ <provider>: {...} }` 或 `{ providers: {...} }`。 */
function sourceProviders(source: Json): Rec | null {
  if (!isRecord(source)) return null
  if (isRecord(source['providers'])) return source['providers'] as Rec
  return source
}

function resolveProviderKey(providers: Rec, vendor: string, body: Rec | null): string | null {
  const candidates = new Set<string>([vendor, stripVendorPrefix(vendor)])
  if (body !== null && typeof body['sdk'] === 'string') candidates.add(body['sdk'] as string)
  for (const candidate of [...candidates]) {
    const alias = PROVIDER_ALIASES[candidate]
    if (alias !== undefined) candidates.add(alias)
  }
  for (const candidate of candidates) {
    if (providers[candidate] !== undefined) return candidate
  }
  const lowered = new Map(Object.keys(providers).map((key) => [key.toLowerCase(), key]))
  for (const candidate of candidates) {
    const hit = lowered.get(candidate.toLowerCase())
    if (hit !== undefined) return hit
  }
  return null
}

function findVendorBody(vendorBodies: Rec, vendor: string): Rec | null {
  const direct = vendorBodies[vendor]
  if (isRecord(direct)) return direct
  const stripped = stripVendorPrefix(vendor)
  for (const [identity, body] of Object.entries(vendorBodies)) {
    if (!isRecord(body)) continue
    if (identity === vendor || identity === `vendor-${stripped}` || body['sdk'] === stripped) return body
  }
  return null
}

/** 从 models.dev 模型条目计算 config 身份的元数据字段。 */
function computeMetadata(entry: Rec, vendorBody: Rec | null): Rec {
  const metadata: Rec = {}
  const limit = isRecord(entry['limit']) ? (entry['limit'] as Rec) : {}
  if (typeof limit['context'] === 'number') metadata['context_window'] = limit['context']
  if (typeof limit['output'] === 'number') metadata['max_output'] = limit['output']
  const reasoning = entry['reasoning']
  if (Array.isArray(reasoning)) metadata['reasoning'] = reasoning
  else if (reasoning === true) {
    const fallback = vendorBody === null ? undefined : vendorBody['default_reasoning']
    if (Array.isArray(fallback) && fallback.length > 0) metadata['reasoning'] = fallback
  }
  const modalities = isRecord(entry['modalities']) ? (entry['modalities'] as Rec) : null
  if (modalities !== null) {
    const normalized: Rec = {}
    if (Array.isArray(modalities['input'])) normalized['input'] = modalities['input']
    if (Array.isArray(modalities['output'])) normalized['output'] = modalities['output']
    if (Object.keys(normalized).length > 0) metadata['modalities'] = normalized
  }
  return metadata
}

/** 按所选 id 计算元数据（只取 source 里存在的模型）。 */
function computeAll(sourceModels: Rec, ids: string[], vendorBody: Rec | null): Rec {
  const metadata: Rec = {}
  for (const id of ids) {
    const entry = sourceModels[id]
    if (isRecord(entry)) metadata[id] = computeMetadata(entry, vendorBody)
  }
  return metadata
}

function findConfigProviderKey(providers: Rec, vendor: string): string | null {
  for (const candidate of [vendor, stripVendorPrefix(vendor), `vendor-${stripVendorPrefix(vendor)}`]) {
    if (providers[candidate] !== undefined) return candidate
  }
  return null
}

/** 读-改-写：只改 providers.<vendor>.models.<id> 的元数据字段，其余原样。 */
function applyMetadata(config: Rec, target: Target, metadata: Rec): Rec {
  const updated = deepClone(config)
  const providers = isRecord(updated['providers']) ? (updated['providers'] as Rec) : null
  if (providers === null) return updated
  const providerKey = findConfigProviderKey(providers, target.vendor)
  if (providerKey === null) return updated
  const provider = providers[providerKey]
  if (!isRecord(provider)) return updated
  const models = isRecord(provider['models']) ? (provider['models'] as Rec) : null
  if (models === null) return updated
  for (const id of target.ids) {
    const model = models[id]
    const meta = metadata[id]
    if (!isRecord(model) || !isRecord(meta)) continue
    for (const key of MANAGED_KEYS) {
      if (meta[key] !== undefined) model[key] = meta[key]
      else delete model[key]
    }
  }
  return updated
}

function targetsFromConfig(config: Rec): Target[] {
  const providers = isRecord(config['providers']) ? (config['providers'] as Rec) : null
  if (providers === null) return []
  const targets: Target[] = []
  for (const [vendor, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue
    const models = isRecord(provider['models']) ? (provider['models'] as Rec) : null
    if (models === null) continue
    targets.push({ vendor, ids: Object.keys(models) })
  }
  return targets
}

function sourceUrl(args: Rec, policy: RetryPolicy): string {
  const fromArgs = args['source_url']
  if (typeof fromArgs === 'string' && fromArgs.length > 0) return fromArgs
  const fromEnv = process.env['CHRONO_MODELS_DEV_URL']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return policy.models_dev_url
}

async function fetchSource(url: string, policy: RetryPolicy, deps: ProfileDeps, now: number): Promise<Json> {
  const response = await withRetry(
    `models.dev:${url}`,
    () =>
      httpRequest({
        method: 'GET',
        url,
        headers: { accept: 'application/json' },
        timeout_ms: policy.request_timeout_ms,
        now,
        classify: (status) =>
          status >= 500
            ? new ModelError('profile_network', `http ${status}`, { retryable: true })
            : new ModelError('profile_bad_source', `http ${status}`),
      }),
    { policy, limiter: deps.limiter, now },
  )
  try {
    return JSON.parse(response.body) as Json
  } catch {
    throw new ModelError('profile_bad_source', 'models.dev response is not JSON')
  }
}

/** 构造写计划：无变化回 extern；有变化回 put + add_gen。 */
function planValue(changed: boolean, newConfig: Rec | null, metadata: Rec): Json {
  if (!changed || newConfig === null) return externOnly({ ok: true, changed: false, models: metadata })
  return planOf([putOp(newConfig), addGenOp('config', 0)], { ok: true, changed: true, models: metadata })
}

/** profile：只刷新调用方所选模型；config 缺省时只回档案值、不产写计划。 */
export async function profile(args: Json, env: CallEnv, deps: ProfileDeps): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const vendor = args['vendor']
  if (typeof vendor !== 'string' || vendor.length === 0) throw new BadArgsError('vendor required')
  const ids = Array.isArray(args['ids']) ? (args['ids'] as Json[]).filter((id): id is string => typeof id === 'string') : null
  if (ids === null) throw new BadArgsError('ids must be an array')
  const config = pickConfig(args)
  const vendorBodies = collectVendorBodies(args)
  const policy = resolvePolicy(args['resilience'])
  try {
    const source = await fetchSource(sourceUrl(args, policy), policy, deps, env.now)
    const providers = sourceProviders(source)
    if (providers === null) throw new ModelError('profile_bad_source', 'models.dev response has no providers')
    const providerKey = resolveProviderKey(providers, vendor, findVendorBody(vendorBodies, vendor))
    if (providerKey === null) return errorValue('profile_vendor_unknown', `no models.dev provider for ${vendor}`)
    const provider = providers[providerKey]
    const sourceModels = isRecord(provider) && isRecord((provider as Rec)['models']) ? ((provider as Rec)['models'] as Rec) : {}
    const metadata = computeAll(sourceModels, ids, findVendorBody(vendorBodies, vendor))
    if (config === null) return { ok: true, changed: false, models: metadata, write: false }
    const updated = applyMetadata(config, { vendor, ids }, metadata)
    const changed = !canonicalEqual(updated, config)
    return planValue(changed, updated, metadata)
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

/** sync：对 config 里已选的全部模型批量刷新（宿主 periodic 直调）。 */
export async function sync(bag: Json, env: CallEnv, deps: ProfileDeps): Promise<Json> {
  if (!isRecord(bag)) throw new BadArgsError('bag must be an object')
  const config = pickConfig(bag)
  if (config === null) return externOnly({ ok: true, changed: false, models: {} })
  const vendorBodies = collectVendorBodies(bag)
  const policy = resolvePolicy(bag['resilience'])
  try {
    const source = await fetchSource(sourceUrl(bag, policy), policy, deps, env.now)
    const providers = sourceProviders(source)
    if (providers === null) throw new ModelError('profile_bad_source', 'models.dev response has no providers')
    let updated = deepClone(config)
    const summary: Rec = {}
    for (const target of targetsFromConfig(config)) {
      const body = findVendorBody(vendorBodies, target.vendor)
      const providerKey = resolveProviderKey(providers, target.vendor, body)
      if (providerKey === null) continue
      const provider = providers[providerKey]
      const sourceModels = isRecord(provider) && isRecord((provider as Rec)['models']) ? ((provider as Rec)['models'] as Rec) : {}
      const metadata = computeAll(sourceModels, target.ids, body)
      summary[target.vendor] = metadata
      updated = applyMetadata(updated, target, metadata)
    }
    const changed = !canonicalEqual(updated, config)
    return planValue(changed, updated, summary)
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

function pickConfig(args: Rec): Rec | null {
  for (const key of ['config', 'config_body', 'body']) {
    if (isRecord(args[key])) return args[key] as Rec
  }
  return null
}
