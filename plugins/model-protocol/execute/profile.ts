// profile / sync：拉 models.dev -> 只取所选模型 -> 经 `config.write` 写 config owner 自有存储。
// 落盘前把社区布尔 true 展开为该 vendor 的 default_reasoning 数组（无则缺键）；写前去重（无变化不写）。
// 推理能力表经反向 `port.call msg-dialect.reasoning-capability` 解析；参数随 args 传入。
// 服务不读投影、不联网以外的世界。

import { DialectClient } from './dialect-link.ts'
import { ModelError, errorValue } from './errors.ts'
import { httpRequest } from './http.ts'
import { canonicalEqual, deepClone, externOnly, isRecord } from './plan.ts'
import { fetchPolicy, portThrottle, withRetry } from './resilience.ts'
import type { RetryPolicy } from './resilience.ts'
import { BadArgsError } from 'plugin-sdk'
import type { CallEnv, Json, PortCaller, Rec } from 'plugin-sdk'
import { collectVendorBodies } from './vendors.ts'

export interface ProfileDeps {
  throttle: PortCaller
  config: PortCaller
  dialect: PortCaller
}

const MANAGED_KEYS = [
  'context_window',
  'max_output',
  'reasoning',
  'reasoning_capability',
  'modalities',
] as const

const PROVIDER_ALIASES: Record<string, string> = {
  'google-genai': 'google',
  dashscope: 'alibaba',
}

interface Target {
  vendor: string
  ids: string[]
  name?: string
  baseUrl?: string
  /** 自定义厂商实例协议（config provider 级 `protocol`），供无模板声明的能力回落。 */
  protocol?: string
}

function stripVendorPrefix(name: string): string {
  return name.replace(/^vendor-/, '')
}

/** 从 base_url 取主机首标签，用作 models.dev provider 候选。 */
function hostLabel(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    const label = host
      .split('.')
      .filter((part) => part.length > 0 && part !== 'api' && part !== 'www')[0]
    return label ?? null
  } catch {
    return null
  }
}

/** models.dev 顶层可能是 `{ <provider>: {...} }` 或 `{ providers: {...} }`。 */
function sourceProviders(source: Json): Rec | null {
  if (!isRecord(source)) return null
  if (isRecord(source['providers'])) return source['providers'] as Rec
  return source
}

function resolveProviderKey(
  providers: Rec,
  vendor: string,
  body: Rec | null,
  hints?: { name?: string; baseUrl?: string },
): string | null {
  const candidates = new Set<string>([vendor, stripVendorPrefix(vendor)])
  if (body !== null && typeof body['sdk'] === 'string') candidates.add(body['sdk'] as string)
  for (const candidate of [...candidates]) {
    const alias = PROVIDER_ALIASES[candidate]
    if (alias !== undefined) candidates.add(alias)
  }
  // 自定义厂商（无 sdk / 非 models.dev 键名）按显示名与 base_url 主机回落到 models.dev provider：
  // 如 config `custom`
  const label = hostLabel(hints?.baseUrl)
  if (label !== null) candidates.add(label)
  for (const candidate of candidates) {
    if (providers[candidate] !== undefined) return candidate
  }
  const lowered = new Map(Object.keys(providers).map((key) => [key.toLowerCase(), key]))
  for (const candidate of candidates) {
    const hit = lowered.get(candidate.toLowerCase())
    if (hit !== undefined) return hit
  }
  const name = hints?.name
  if (typeof name === 'string' && name.length > 0) {
    const byName = new Map(
      Object.entries(providers)
        .filter(
          ([, provider]) => isRecord(provider) && typeof (provider as Rec)['name'] === 'string',
        )
        .map(([key, provider]) => [(provider as Rec)['name'] as string, key]),
    )
    const hit = byName.get(name)
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
    if (identity === vendor || identity === `vendor-${stripped}` || body['sdk'] === stripped)
      return body
  }
  return null
}

/** 从 models.dev 条目的 `reasoning_options` 取 effort 档位值（low/medium/high…）。 */
function effortValues(entry: Rec): string[] | null {
  const options = entry['reasoning_options']
  if (!Array.isArray(options)) return null
  for (const option of options) {
    if (!isRecord(option) || option['type'] !== 'effort') continue
    const values = Array.isArray(option['values'])
      ? (option['values'] as Json[]).filter((value): value is string => typeof value === 'string')
      : []
    if (values.length > 0) return values
  }
  return null
}

/**
 * 推理能力档案：厂商模板 `quirks.reasoning_replay` 声明优先（厂商口径内置在各自模板）；
 * 未声明（自定义厂商 / 协议端点）走协议默认 + 实例 protocol 回落，未知协议即保守默认。
 */
async function templateCapability(
  dialect: DialectClient,
  vendorBody: Rec | null,
  vendor: string,
  protocolHint: string | null,
): Promise<Rec> {
  const quirks =
    vendorBody !== null && isRecord(vendorBody['quirks']) ? (vendorBody['quirks'] as Rec) : {}
  const declared = isRecord(quirks['reasoning_replay']) ? (quirks['reasoning_replay'] as Rec) : null
  if (declared !== null) {
    return dialect.reasoningCapability({
      profile: {
        retention: 'turn',
        requires_replay_in_tool_loop: declared['requires_in_tool_loop'] === true,
        signature_field:
          typeof declared['signature_field'] === 'string' ? declared['signature_field'] : null,
        replay_form: typeof declared['form'] === 'string' ? declared['form'] : null,
        invalidated_by: ['model_change', 'prefix_change', 'thinking_param_change'],
        verified: declared['verified'] === true,
      },
    })
  }
  const sdk =
    vendorBody !== null && typeof vendorBody['sdk'] === 'string'
      ? (vendorBody['sdk'] as string)
      : null
  const templateProtocol =
    typeof quirks['protocol'] === 'string' ? (quirks['protocol'] as string) : null
  return dialect.reasoningCapability({
    provider: sdk ?? vendor,
    impl: typeof quirks['impl'] === 'string' ? (quirks['impl'] as string) : null,
    // 实例 protocol 优先（与请求期 `protocolOverride ?? quirks.protocol` 对齐），模板 protocol 仅作缺省。
    protocol: protocolHint ?? templateProtocol,
  })
}

/** 厂商模板是否显式声明了思考回传（`quirks.reasoning_replay`）。声明即视为「确有推理能力」的证据。 */
function declaresReplay(vendorBody: Rec | null): boolean {
  if (vendorBody === null || !isRecord(vendorBody['quirks'])) return false
  return isRecord((vendorBody['quirks'] as Rec)['reasoning_replay'])
}

/** 从 models.dev 模型条目计算 config 身份的元数据字段。 */
function computeMetadata(
  entry: Rec,
  vendorBody: Rec | null,
  capability: Rec,
  conservative: Rec,
  declaredReplay: boolean,
): Rec {
  const metadata: Rec = {}
  const limit = isRecord(entry['limit']) ? (entry['limit'] as Rec) : {}
  const contextWindow = typeof limit['context'] === 'number' ? (limit['context'] as number) : null
  if (contextWindow !== null) metadata['context_window'] = contextWindow
  if (typeof limit['output'] === 'number') {
    const output = limit['output'] as number
    // `max_output` 只作请求输出上限的天花板，夹到不超过窗本身（models.dev 偶有 `output ≥ context` 的
    // 脏条目，如 step-3.7-flash 262144）。输入预算不再静态扣输出：输出在请求期按剩余动态给。
    metadata['max_output'] = contextWindow === null ? output : Math.min(output, contextWindow)
  }
  const reasoning = entry['reasoning']
  const efforts = effortValues(entry)
  if (efforts !== null) metadata['reasoning'] = efforts
  else if (Array.isArray(reasoning)) metadata['reasoning'] = reasoning
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
  // 有推理档位、或厂商显式声明了回传能力 ⇒ 写解析出的能力；否则按「不回传、不发思考参数」的保守档，
  // 避免对不支持推理的模型误发参数。厂商声明是「确有推理能力」的证据，故不受档位字段缺失拖累。
  const reasoningCapable = Array.isArray(metadata['reasoning']) || declaredReplay
  metadata['reasoning_capability'] = reasoningCapable ? capability : conservative
  return metadata
}

/** 按所选 id 计算元数据（只取 source 里存在的模型）。 */
function computeAll(
  sourceModels: Rec,
  ids: string[],
  vendorBody: Rec | null,
  capability: Rec,
  conservative: Rec,
): Rec {
  const declaredReplay = declaresReplay(vendorBody)
  const metadata: Rec = {}
  for (const id of ids) {
    const entry = sourceModels[id]
    if (isRecord(entry))
      metadata[id] = computeMetadata(entry, vendorBody, capability, conservative, declaredReplay)
  }
  return metadata
}

function findConfigProviderKey(providers: Rec, vendor: string): string | null {
  for (const candidate of [
    vendor,
    stripVendorPrefix(vendor),
    `vendor-${stripVendorPrefix(vendor)}`,
  ]) {
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
    const target: Target = { vendor, ids: Object.keys(models) }
    if (typeof provider['name'] === 'string') target.name = provider['name'] as string
    if (typeof provider['base_url'] === 'string') target.baseUrl = provider['base_url'] as string
    if (typeof provider['protocol'] === 'string') target.protocol = provider['protocol'] as string
    targets.push(target)
  }
  return targets
}

/** 从 config 取某 provider 的显示名 / base_url / protocol，供 models.dev 回落匹配与能力回落。 */
function providerHints(
  config: Rec | null,
  vendor: string,
): { name?: string; baseUrl?: string; protocol?: string } {
  if (config === null) return {}
  const providers = isRecord(config['providers']) ? (config['providers'] as Rec) : null
  if (providers === null) return {}
  const key = findConfigProviderKey(providers, vendor)
  if (key === null) return {}
  const provider = providers[key]
  if (!isRecord(provider)) return {}
  const hints: { name?: string; baseUrl?: string; protocol?: string } = {}
  if (typeof provider['name'] === 'string') hints.name = provider['name'] as string
  if (typeof provider['base_url'] === 'string') hints.baseUrl = provider['base_url'] as string
  if (typeof provider['protocol'] === 'string') hints.protocol = provider['protocol'] as string
  return hints
}

function sourceUrl(args: Rec, policy: RetryPolicy): string {
  const fromArgs = args['source_url']
  if (typeof fromArgs === 'string' && fromArgs.length > 0) return fromArgs
  const fromEnv = process.env['CHRONO_MODELS_DEV_URL']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return policy.models_dev_url
}

/** models.dev 源进程内缓存时长。 */
const SOURCE_CACHE_MS = 10 * 60 * 1000

let sourceCache: { url: string; at: number; source: Json } | null = null

async function fetchSource(
  url: string,
  policy: RetryPolicy,
  deps: ProfileDeps,
  now: number,
): Promise<Json> {
  // models.dev 索引数 MB：profile（每次界面装载都可能触发）与 periodic sync 共用进程内短缓存，
  // 避免反复拉整份源；首拉失败不缓存，下次仍重试。
  if (sourceCache !== null && sourceCache.url === url && now - sourceCache.at < SOURCE_CACHE_MS) {
    return sourceCache.source
  }
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
    { policy, throttle: portThrottle(deps.throttle), now },
  )
  let source: Json
  try {
    source = JSON.parse(response.body) as Json
  } catch {
    throw new ModelError('profile_bad_source', 'models.dev response is not JSON')
  }
  sourceCache = { url, at: now, source }
  return source
}

/** 无变化回 extern；有变化经 `config.write` 写 owner 自有存储，再回 extern 摘要。 */
async function persist(
  deps: ProfileDeps,
  changed: boolean,
  newConfig: Rec | null,
  metadata: Rec,
): Promise<Json> {
  if (!changed || newConfig === null)
    return externOnly({ ok: true, changed: false, models: metadata })
  const outcome = await deps.config.call('config', 'write', { body: newConfig })
  if (!outcome.ok) {
    return externOnly({
      ok: false,
      changed: false,
      error: { code: outcome.code, message: outcome.message },
      models: metadata,
    })
  }
  return externOnly({ ok: true, changed: true, models: metadata })
}

/** profile：只刷新调用方所选模型；config 缺省时只回档案值、不产写计划。 */
export async function profile(args: Json, env: CallEnv, deps: ProfileDeps): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const vendor = args['vendor']
  if (typeof vendor !== 'string' || vendor.length === 0) throw new BadArgsError('vendor required')
  const ids = Array.isArray(args['ids'])
    ? (args['ids'] as Json[]).filter((id): id is string => typeof id === 'string')
    : null
  if (ids === null) throw new BadArgsError('ids must be an array')
  const config = pickConfig(args)
  const vendorBodies = collectVendorBodies(args)
  const policy = await fetchPolicy(deps.throttle, args['resilience'])
  const dialect = new DialectClient(deps.dialect)
  try {
    const source = await fetchSource(sourceUrl(args, policy), policy, deps, env.now)
    const providers = sourceProviders(source)
    if (providers === null)
      throw new ModelError('profile_bad_source', 'models.dev response has no providers')
    const vendorBody = findVendorBody(vendorBodies, vendor)
    const hints = providerHints(config, vendor)
    const providerKey = resolveProviderKey(providers, vendor, vendorBody, hints)
    if (providerKey === null)
      return errorValue('profile_vendor_unknown', `no models.dev provider for ${vendor}`)
    const provider = providers[providerKey]
    const sourceModels =
      isRecord(provider) && isRecord((provider as Rec)['models'])
        ? ((provider as Rec)['models'] as Rec)
        : {}
    const capability = await templateCapability(dialect, vendorBody, vendor, hints.protocol ?? null)
    const conservative = await dialect.reasoningCapability({})
    const metadata = computeAll(sourceModels, ids, vendorBody, capability, conservative)
    if (config === null) return { ok: true, changed: false, models: metadata, write: false }
    const updated = applyMetadata(config, { vendor, ids }, metadata)
    const changed = !canonicalEqual(updated, config)
    return persist(deps, changed, updated, metadata)
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

/** sync：对 config 里已选的全部模型批量刷新（宿主 periodic 直调；config 经 `config.read` 问 owner）。 */
export async function sync(bag: Json, env: CallEnv, deps: ProfileDeps): Promise<Json> {
  if (!isRecord(bag)) throw new BadArgsError('bag must be an object')
  const read = await deps.config.call('config', 'read', {})
  const fromOwner =
    read.ok && isRecord(read.value) && isRecord(read.value['body'])
      ? (read.value['body'] as Rec)
      : null
  const config = fromOwner ?? pickConfig(bag)
  if (config === null) return externOnly({ ok: true, changed: false, models: {} })
  const vendorBodies = collectVendorBodies(bag)
  const policy = await fetchPolicy(deps.throttle, bag['resilience'])
  const dialect = new DialectClient(deps.dialect)
  try {
    const source = await fetchSource(sourceUrl(bag, policy), policy, deps, env.now)
    const providers = sourceProviders(source)
    if (providers === null)
      throw new ModelError('profile_bad_source', 'models.dev response has no providers')
    const conservative = await dialect.reasoningCapability({})
    let updated = deepClone(config)
    const summary: Rec = {}
    for (const target of targetsFromConfig(config)) {
      const body = findVendorBody(vendorBodies, target.vendor)
      const providerKey = resolveProviderKey(providers, target.vendor, body, {
        name: target.name,
        baseUrl: target.baseUrl,
      })
      if (providerKey === null) continue
      const provider = providers[providerKey]
      const sourceModels =
        isRecord(provider) && isRecord((provider as Rec)['models'])
          ? ((provider as Rec)['models'] as Rec)
          : {}
      const capability = await templateCapability(dialect, body, target.vendor, target.protocol ?? null)
      const metadata = computeAll(sourceModels, target.ids, body, capability, conservative)
      summary[target.vendor] = metadata
      updated = applyMetadata(updated, target, metadata)
    }
    const changed = !canonicalEqual(updated, config)
    return persist(deps, changed, updated, summary)
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
