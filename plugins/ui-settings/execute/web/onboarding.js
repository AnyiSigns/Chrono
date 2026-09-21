// 引导页纯函数（node 下可 import 单测）：厂商模板抽取 / 探测槽 / 模型列表归一 / 表单校验。
// 模板与自定义共用同一流程：模板只是预填来源不同（厂商模板身份的 body 是预填真源）。

import { enabledModelIds, isRecord, vendorKeyOf } from './config-model.js'

/** 三个自定义基础协议（config 里自定义厂商的 `protocol`）。 */
export const CUSTOM_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages']

/** 厂商模板身份中代表「自定义」的一项（表单里由显式 custom 选项承担，不再重复列出）。 */
export const CUSTOM_TEMPLATE_IDENTITY = 'vendor-custom'

/** 从投影 `ctx.ids` 抽厂商模板（键以 `vendor-` 开头的身份 body）。 */
export function vendorTemplates(ids) {
  if (!isRecord(ids)) return []
  const list = []
  for (const identity of Object.keys(ids)) {
    if (!identity.startsWith('vendor-')) continue
    const entry = ids[identity]
    const body = isRecord(entry) && isRecord(entry.body) ? entry.body : null
    if (body === null) continue
    list.push(templateOf(identity, body))
  }
  list.sort(compareTemplates)
  return list
}

/** 从 `model.vendors` 结果 `{ok:true, vendors:[{identity, default_base_url, default_auth_ref_name, default_reasoning}]}` 抽模板。 */
export function vendorTemplatesFromResult(value) {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.vendors)) return []
  const list = []
  for (const item of value.vendors) {
    if (!isRecord(item) || typeof item.identity !== 'string') continue
    list.push(templateOf(item.identity, item))
  }
  list.sort(compareTemplates)
  return list
}

/** 表单项可选模板：去掉与显式 custom 选项重复的 `vendor-custom`。 */
export function selectableTemplates(templates) {
  return (Array.isArray(templates) ? templates : []).filter(
    (item) => isRecord(item) && item.identity !== CUSTOM_TEMPLATE_IDENTITY,
  )
}

function templateOf(identity, body) {
  return {
    identity,
    key: vendorKeyOf(identity),
    sdk: typeof body.sdk === 'string' ? body.sdk : vendorKeyOf(identity),
    default_base_url: typeof body.default_base_url === 'string' ? body.default_base_url : '',
    default_auth_ref_name: typeof body.default_auth_ref_name === 'string' ? body.default_auth_ref_name : '',
    default_reasoning: Array.isArray(body.default_reasoning) ? body.default_reasoning : [],
  }
}

function compareTemplates(left, right) {
  return left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0
}

/** 引导 / 新建厂商表单初始态。 */
export function defaultOnboarding() {
  return {
    mode: 'form',
    editKey: '',
    step: 'form',
    templates: [],
    templateIdentity: '',
    vendor: 'vendor-custom',
    key: 'custom',
    protocol: CUSTOM_PROTOCOLS[0],
    base_url: '',
    auth_kind: 'env',
    auth_name: '',
    secret_value: '',
    models: [],
    selected: [],
    model: '',
    error: null,
    busy: false,
    loading: false,
    loadingNote: false,
  }
}

/**
 * 已保存厂商 → 编辑表单（改 `base_url` / `auth_ref`，模型与档案元数据原样保留）。
 * 编辑模式只渲染地址与密钥引用，不重跑模板 / 发现流程。
 */
export function onboardingFromEntry(key, entry) {
  const auth = isRecord(entry) && isRecord(entry.auth_ref) ? entry.auth_ref : {}
  const models = enabledModelIds(entry)
  return {
    ...defaultOnboarding(),
    mode: 'edit',
    editKey: key,
    vendor: `vendor-${key}`,
    key,
    protocol: isRecord(entry) && typeof entry.protocol === 'string' ? entry.protocol : CUSTOM_PROTOCOLS[0],
    base_url: isRecord(entry) && typeof entry.base_url === 'string' ? entry.base_url : '',
    auth_kind: auth.kind === 'local' ? 'local' : 'env',
    auth_name: typeof auth.name === 'string' ? auth.name : '',
    models,
    selected: models.slice(),
    model: models.length > 0 ? models[0] : '',
  }
}

/** 切换模板：自定义清空预填，预设模板按 body 预填（模板只是预填来源）。 */
export function applyTemplate(form, identity) {
  form.templateIdentity = identity === 'custom' ? 'custom' : identity
  const prefill =
    identity === 'custom'
      ? { key: 'custom', base_url: '', auth_ref_name: '', sdk: '' }
      : templatePrefill(form.templates, identity)
  form.vendor = identity === 'custom' ? CUSTOM_TEMPLATE_IDENTITY : identity
  form.key = prefill.key || 'custom'
  form.base_url = prefill.base_url
  form.auth_name = prefill.auth_ref_name
  form.models = []
  form.selected = []
  form.model = ''
  form.error = null
}

/** 表单 → 引导写值（`auth_ref` 只存引用，不存密钥本体）。 */
export function formToValue(form) {
  return {
    vendor: form.vendor,
    key: form.key,
    protocol: form.templateIdentity === 'custom' ? form.protocol : undefined,
    base_url: form.base_url,
    auth_ref: { kind: form.auth_kind, name: form.auth_name },
    models: form.selected,
    model: form.model,
  }
}

/** 取某模板的预填值（模板不存在返回空预填）。 */
export function templatePrefill(templates, identity) {
  const hit = Array.isArray(templates) ? templates.find((item) => item.identity === identity) : undefined
  if (hit === undefined) return { key: '', base_url: '', auth_ref_name: '', sdk: '' }
  return { key: hit.key, base_url: hit.default_base_url, auth_ref_name: hit.default_auth_ref_name, sdk: hit.sdk }
}

/**
 * 构造 `model.probe` 槽体（模型协议身份 `discover` 的入参真源）。
 * `auth_ref` 只存引用（kind + name），不存密钥本体。
 */
export function buildProbeSlot(form) {
  const slot = { kind: 'model.probe', url: form.base_url, auth_ref: { kind: form.auth_ref.kind, name: form.auth_ref.name } }
  if (typeof form.protocol === 'string' && form.protocol.length > 0) slot.protocol = form.protocol
  return slot
}

/** 归一模型协议身份 `discover` 的返回值：`{ok:true,models:[…]}` → 排序去重 id 列表；失败 → 空列表。 */
export function discoverModels(value) {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.models)) return []
  const ids = new Set()
  for (const id of value.models) {
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return [...ids].sort()
}

/** discover 失败码（结构化错误，落行内 danger，不弹窗）。 */
export function discoverErrorCode(value) {
  if (!isRecord(value) || value.ok !== false) return null
  const error = isRecord(value.error) ? value.error : null
  if (error !== null && typeof error.code === 'string') return error.code
  return 'discover_unsupported'
}

/** 表单校验：返回错误码或 null。 */
export const ONBOARDING_BAD_URL = 'settings_bad_url'
export const ONBOARDING_REQUIRED = 'settings_required'

/** 地址形态校验（http / https）；缺失 → 必填，非法 → 地址错误。 */
export function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return ONBOARDING_REQUIRED
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ONBOARDING_BAD_URL
  } catch {
    return ONBOARDING_BAD_URL
  }
  return null
}

/** 密钥引用校验：须为 `{kind:'local'|'env', name}` 且 name 非空。 */
export function validateAuthRef(value) {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) {
    return ONBOARDING_REQUIRED
  }
  if (value.kind !== 'local' && value.kind !== 'env') return ONBOARDING_REQUIRED
  return null
}

/** 探测前置校验：地址形态 + 引用名（获取模型尚不需要模型列表）。 */
export function validateProbe(form) {
  const base = validateBaseUrl(form.base_url)
  if (base !== null) return base
  return validateAuthRef({ kind: form.auth_kind, name: form.auth_name })
}

export function validateOnboarding(form) {
  const base = validateBaseUrl(form.base_url)
  if (base !== null) return base
  const auth = validateAuthRef(form.auth_ref)
  if (auth !== null) return auth
  if (!Array.isArray(form.models) || form.models.length === 0) return ONBOARDING_REQUIRED
  if (typeof form.model !== 'string' || form.model.length === 0) return ONBOARDING_REQUIRED
  if (!form.models.includes(form.model)) return ONBOARDING_REQUIRED
  return null
}

/** 默认模型选择：保留旧选择（若仍在列表内），否则取列表首项。 */
export function defaultModelChoice(models, previous) {
  if (typeof previous === 'string' && models.includes(previous)) return previous
  return models.length > 0 ? models[0] : ''
}

/** 是否已配置：config body 有 `vendor` 键（壳判「无配置」同口径）。 */
export function isConfigured(config) {
  return isRecord(config) && typeof config.vendor === 'string' && config.vendor.length > 0
}
