// 配置读-改-写纯函数（浏览器侧，node 下可 import 单测）。
// 写一律「客户端身份」经入站面提交：整值 put + add_gen（不改身份本体以外的东西）。
// 本模块只构造新的 config body 与 directive，不触 DOM、不发请求。

/** 身份 id 常量（模块内部用）。 */
const CONFIG_ID = 'config'
const INPUT_ID = 'input'

/** 判断普通对象（非数组 / 非 null）。 */
export function isRecord(value: any): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
export function identityBody(value: any): any {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'body') ? value.body : value
}

/** 身份视图 → active（64hex 或 null）；非身份视图 / 形状不符回 undefined（不注入 expect_active）。 */
export function identityActive(value: any): string | null | undefined {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'active')) return undefined
  const active = value.active
  return typeof active === 'string' || active === null ? active : undefined
}

/** 身份数据侧特征键：出现任一即视为数据 body，不判为代码世代回落。 */
const DATA_SIDE_KEYS = ['version', 'params', 'permission', 'ui', 'providers', 'slots']

/** 代码世代回落 body 判据：拿到的是 active（commit）def body，非身份数据，拒写。
 * commit def body 形如 `{ tree, meta }`；只判顶层含 `tree` 会误伤顶层恰好含 `tree` 的合法数据
 * （config schema 允许额外键），故要求 `tree` 为字符串且不含任一数据侧特征键。 */
export function isCodeGenFallbackBody(body: any): boolean {
  if (!isRecord(body) || typeof body.tree !== 'string') return false
  for (const key of DATA_SIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return false
  }
  return true
}

/** 结构克隆（JSON 值）。 */
export function clone(value: any): any {
  return JSON.parse(JSON.stringify(value))
}

/** 元信息行拼接：过滤非空串后用 ` · ` 连接（组件不就地拼串）。 */
export function joinMeta(parts: unknown[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')
}

/** seed 默认 config body（与配置身份默认一致；用于「无配置」时本地兜底）。 */
export function emptyConfig(): any {
  return {
    version: 1,
    params: {},
    permission: 'review',
    ui: { theme: 'system', style: '', sidebar_width: 260 },
    providers: {},
  }
}

/** 厂商身份名去 `vendor-` 前缀，得 config `providers` 键。 */
export function vendorKeyOf(identity: any): string {
  return String(identity).replace(/^vendor-/, '')
}

/** 列出已保存厂商 `[{key, entry}]`（键排序保确定性）。 */
export function providerList(config: any): { key: string; entry: any }[] {
  if (!isRecord(config) || !isRecord(config.providers)) return []
  return Object.keys(config.providers)
    .sort()
    .map((key) => ({ key, entry: config.providers[key] }))
    .filter((item) => isRecord(item.entry))
}

/** 已勾选模型 id（`enabled !== false` 视为勾选）。 */
export function enabledModelIds(entry: any): string[] {
  if (!isRecord(entry) || !isRecord(entry.models)) return []
  return Object.keys(entry.models).filter((id) => {
    const model = entry.models[id]
    return isRecord(model) ? model.enabled !== false : false
  })
}

/** 构造一个厂商连接实例（只存 auth_ref，不存密钥本体；无引用 = 匿名，省略 auth_ref）。 */
export function providerEntry(form: any): any {
  const models: Record<string, any> = {}
  for (const id of Array.isArray(form.models) ? form.models : []) {
    if (typeof id !== 'string' || id.length === 0) continue
    models[id] = { name: id, enabled: true }
  }
  const entry: any = {
    name: typeof form.name === 'string' && form.name.length > 0 ? form.name : form.key,
    base_url: form.base_url,
    models,
  }
  if (isRecord(form.auth_ref) && typeof form.auth_ref.name === 'string' && form.auth_ref.name.length > 0) {
    entry.auth_ref = { kind: form.auth_ref.kind, name: form.auth_ref.name }
  }
  if (typeof form.protocol === 'string' && form.protocol.length > 0) entry.protocol = form.protocol
  return entry
}

/** 新增 / 覆盖一个厂商连接实例（其余字段原样）。 */
export function upsertProvider(config: any, key: string, entry: any): any {
  const base = isRecord(config) ? clone(config) : emptyConfig()
  const providers = isRecord(base.providers) ? base.providers : {}
  base.providers = { ...providers, [key]: entry }
  return base
}

/** 删除一个厂商连接实例；若删的是当前选择，同时清掉 vendor / model。 */
export function removeProvider(config: any, key: string): any {
  const base = isRecord(config) ? clone(config) : emptyConfig()
  const providers = isRecord(base.providers) ? base.providers : {}
  delete providers[key]
  base.providers = providers
  if (base.vendor === key) {
    delete base.vendor
    delete base.model
  }
  return base
}

/** 合并写入 `params` 字段（只覆盖给出的键）。 */
export function setParams(config: any, params: any): any {
  const base = isRecord(config) ? clone(config) : emptyConfig()
  const current = isRecord(base.params) ? base.params : {}
  base.params = { ...current, ...params }
  return base
}

/** 写 `ui.<field>`（只覆盖给出字段）。 */
export function setUiField(config: any, field: string, value: any): any {
  const base = isRecord(config) ? clone(config) : emptyConfig()
  const ui = isRecord(base.ui) ? base.ui : {}
  base.ui = { ...ui, [field]: value }
  return base
}

/** 写 `ui.notify.<key>`（缺省整组仍保留）。 */
export function setNotify(config: any, key: string, value: any): any {
  const base = isRecord(config) ? clone(config) : emptyConfig()
  const ui = isRecord(base.ui) ? base.ui : {}
  const notify = isRecord(ui.notify) ? ui.notify : {}
  base.ui = { ...ui, notify: { ...notify, [key]: value } }
  return base
}

/** 读 `ui.notify` 整组（缺省空表）。 */
export function notifyOf(config: any): any {
  if (!isRecord(config) || !isRecord(config.ui) || !isRecord(config.ui.notify)) return {}
  return config.ui.notify
}

/**
 * 引导完成：把表单合并进 config body。
 * 表单 `{vendor, key?, protocol?, base_url, auth_ref:{kind,name}, models:[…], params?}`。
 * 不写当前选择（`vendor` / `model`）：当前模型由对话输入框选择时写。
 */
export function buildOnboardingConfig(existing: any, form: any): any {
  const key = typeof form.key === 'string' && form.key.length > 0 ? form.key : vendorKeyOf(form.vendor)
  const withProvider = upsertProvider(existing, key, providerEntry({ ...form, key }))
  return isRecord(form.params) ? setParams(withProvider, form.params) : withProvider
}

/** 一条 batch 写指令：put 整值 + add_gen 绑定身份（四字段全必填、占位符指回 put）。
 * `expectActive` 为读回身份视图的 active：显式条件写，陈旧读由内核 `stale_active` 拒写。 */
export function batchWriteDirective(identity: string, body: any, expectActive?: string | null): any {
  const addGen: any = { id: identity, payload: { $n: 0 }, sig: { $n: 0 }, pins: {} }
  if (expectActive !== undefined) addGen.expect_active = expectActive
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body } },
          { op: 'add_gen', args: addGen },
        ],
      },
    },
  }
}

/** config 整值写指令。 */
export function configWriteDirective(body: any, expectActive?: string | null): any {
  return batchWriteDirective(CONFIG_ID, body, expectActive)
}

/** 写输入槽：只覆盖本线程键（读-改-写，其余键原样）。 */
export function slotWriteDirective(slots: any, threadKey: string, slot: any, expectActive?: string | null): any {
  const nextSlots = { ...(isRecord(slots) ? slots : {}), [threadKey]: slot }
  return batchWriteDirective(INPUT_ID, { slots: nextSlots }, expectActive)
}

/** 导出 JSON 文本（整份 body，`auth_ref` 只有引用名、无明文）。 */
export function exportJson(config: any): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** 导入校验结果码（模块内部用）。 */
const IMPORT_BAD_JSON = 'settings_import_bad_json'
const IMPORT_BAD_SHAPE = 'settings_import_bad_shape'

const PERMISSION_VALUES = ['auto', 'severe', 'review', 'deny']
const THEME_VALUES = ['day', 'night', 'system']

/** 主题卡片 id：config 的用户语义为 `day` / `night` / `system`，兼容壳落 DOM 的 `light` / `dark` 词表。 */
export function themeCardOf(value: any): string {
  if (value === 'day' || value === 'light') return 'day'
  if (value === 'night' || value === 'dark') return 'night'
  return 'system'
}

/** 机械校验导入的 config 文本（白名单子集口径的写入端校验；宿主不校验身份数据）。 */
export function validateImport(text: any): any {
  let parsed: any
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return { ok: false, code: IMPORT_BAD_JSON }
  }
  if (!isRecord(parsed)) return { ok: false, code: IMPORT_BAD_SHAPE }
  for (const key of ['version', 'params', 'permission', 'ui', 'providers']) {
    if (!(key in parsed)) return { ok: false, code: IMPORT_BAD_SHAPE }
  }
  if (!Number.isInteger(parsed.version)) return { ok: false, code: IMPORT_BAD_SHAPE }
  if (!isRecord(parsed.params) || !isRecord(parsed.ui) || !isRecord(parsed.providers)) {
    return { ok: false, code: IMPORT_BAD_SHAPE }
  }
  if (!PERMISSION_VALUES.includes(parsed.permission)) return { ok: false, code: IMPORT_BAD_SHAPE }
  if (parsed.ui.theme !== undefined && !THEME_VALUES.includes(parsed.ui.theme)) {
    return { ok: false, code: IMPORT_BAD_SHAPE }
  }
  return { ok: true, body: parsed }
}
