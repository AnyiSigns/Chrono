// 工具目录：扩展类 `tool-provider` 的世界成员表（宿主按世界能力索引注入）逐个反向 `describe`
// + 外部 MCP 工具（调用方随 bag 传入的投影清单）。做四要素 / argsSchema 白名单 / caps 形状校验
// 与工具名全局唯一性校验；不合规项不进目录（`bad_tool_decl`），并在 rejected 里留诊断。
// argsSchema 白名单校验 / 净化与 caps 形状校验由同包 `schema-validate.ts` 纯函数提供。
// 加 / 减一个工具提供方 = 世界成员表变化，本模块代码零改动（不枚举提供方）。

import { canonicalJson, isRecord } from 'plugin-sdk'
import type { Json, PortCaller, Rec } from './types.ts'

/** 工具提供方扩展类（拥有方 `slots` 契约）：成员由宿主注入的 `many` 成员表给出。 */
const TOOL_PROVIDER = 'tool-provider'

/** 四要素键。 */
const ELEMENTS = ['intent', 'when_to_use', 'boundaries'] as const

/** 缺省 caps：不触盘、不触网（归一失败时的兜底，与 `normalizeCaps` 缺省同形）。 */
const DEFAULT_CAPS: Rec = { fs: { read: 'none', write: 'none' }, net: 'unset' }

/** argsSchema 白名单 / caps 校验后端（生产环境实现住同包 `methods.ts` 的 `LOCAL_SCHEMA`）。 */
export interface SchemaBackend {
  /** 严格：白名单校验；宽松：剥白名单外关键词。回可用 schema 或失败原因。 */
  normalizeDecl(schema: Json | undefined, lenient: boolean): Promise<DeclOutcome>
  /** 归一 caps 对象形并校验；宽松模式缺项按 none、非对象回落缺省。 */
  normalizeCaps(caps: Json | undefined, lenient: boolean): Promise<CapsOutcome>
}

export interface DeclOutcome {
  ok: boolean
  message: string
  schema: Json | null
}

export interface CapsOutcome {
  ok: boolean
  message: string
  caps: Rec | null
}

export interface Rejection {
  name: string
  code: string
  message: string
}

export interface ToolEntry {
  name: string
  /** 派发用的逻辑端口名（describe/invoke 提供者 = 其类名；绑定项 = 绑定声明的 class）。 */
  provider: string
  kind: 'invoke' | 'binding'
  /** 绑定项的能力类方法；`null` = 投影读（无服务调用）。 */
  method: string | null
  /** 投影读的 bag 键（缺省 = 工具名）。 */
  read: string | null
  /** 对外暴露的完整声明（含 provider / kind，供调用方渲染与派发）。 */
  decl: Rec
}

export interface Directory {
  tools: ToolEntry[]
  byName: Map<string, ToolEntry>
  rejected: Rejection[]
}

export interface BuildInput {
  pins: string[]
  /** 扩展类 `tool-provider` 的世界成员（提供方身份名，码元序）；每个成员逐个反向 `describe`。 */
  manyProviders: string[]
  bag: Rec
  link: PortCaller
  schema: SchemaBackend
}

/** 从 `{tools:[...]}` 形态的 describe 结果里取工具数组；形态不符回空。 */
export function toolsOf(value: Json): Json[] {
  if (!isRecord(value)) return []
  const tools = value['tools']
  return Array.isArray(tools) ? tools : []
}

/** 从 list 的输出（或 bag.directory）重建目录：按名索引，保留 provider / kind / method / read。 */
export function directoryFromJson(json: Json): Directory {
  const record = isRecord(json) ? json : {}
  const rawTools = Array.isArray(record['tools']) ? (record['tools'] as Json[]) : []
  const rejected = Array.isArray(record['rejected'])
    ? (record['rejected'] as Json[]).filter(isRecord).map((item) => ({
        name: typeof item['name'] === 'string' ? (item['name'] as string) : '',
        code: typeof item['code'] === 'string' ? (item['code'] as string) : 'bad_tool_decl',
        message: typeof item['message'] === 'string' ? (item['message'] as string) : '',
      }))
    : []
  const tools: ToolEntry[] = []
  for (const raw of rawTools) {
    if (!isRecord(raw)) continue
    const name = raw['name']
    if (typeof name !== 'string' || name.length === 0) continue
    const kind = raw['kind'] === 'binding' ? 'binding' : 'invoke'
    const provider = typeof raw['provider'] === 'string' ? (raw['provider'] as string) : ''
    const method = typeof raw['method'] === 'string' ? (raw['method'] as string) : null
    const read = typeof raw['read'] === 'string' ? (raw['read'] as string) : null
    tools.push({ name, provider, kind, method, read, decl: raw })
  }
  return { tools, byName: new Map(tools.map((entry) => [entry.name, entry])), rejected }
}

/**
 * 解析目录：优先复用调用方传入的 list 结果（`bag.directory` / `bag.tools`），否则现场装配。
 * 复用路径不再拉 describe，也不重复校验。
 */
export async function listDirectory(input: BuildInput): Promise<Directory> {
  const bag = input.bag
  if (isRecord(bag['directory']) && Array.isArray((bag['directory'] as Rec)['tools'])) {
    return directoryFromJson(bag['directory'])
  }
  if (Array.isArray(bag['tools'])) {
    return directoryFromJson({ tools: bag['tools'], rejected: [] })
  }
  return buildDirectory(input)
}

/**
 * 构造目录：并发拉**扩展类 `tool-provider` 全部世界成员**的 `describe`，并入绑定表与外部 MCP 工具，
 * 逐项校验、按工具名去重。成员 `describe` 不可用（未就绪 / 出错）只跳过该成员，不阻断目录。
 * 成员来自调用方注入的世界成员表，故加减提供方不改本模块。
 */
export async function buildDirectory(input: BuildInput): Promise<Directory> {
  const { pins, manyProviders, bag, link, schema } = input
  const tools: ToolEntry[] = []
  const rejected: Rejection[] = []
  const seen = new Set<string>()

  const push = (entry: ToolEntry | null, reject: Rejection | null): void => {
    if (reject !== null) {
      rejected.push(reject)
      return
    }
    if (entry === null) return
    if (seen.has(entry.name)) {
      rejected.push({ name: entry.name, code: 'bad_tool_decl', message: 'duplicate tool name' })
      return
    }
    seen.add(entry.name)
    tools.push(entry)
  }

  const described = await Promise.all(
    manyProviders.map(async (provider) => ({
      provider,
      value: await link.call(TOOL_PROVIDER, 'describe', {}, { provider }),
    })),
  )
  for (const { provider, value } of described) {
    if (!value.ok) continue
    for (const raw of toolsOf(value.value)) {
      const outcome = await normalizeInvokeTool(raw, provider, false, schema)
      if (outcome.entry !== null) push(outcome.entry, null)
      else push(null, { name: nameOf(raw), code: 'bad_tool_decl', message: outcome.message })
    }
  }

  const bindings = normalizeBindings(bag['tools_bindings'])
  for (const [name, item] of bindings) {
    const outcome = await normalizeBinding(name, item, pins, schema)
    if (outcome.entry !== null) push(outcome.entry, null)
    else push(null, { name, code: 'bad_tool_decl', message: outcome.message })
  }

  const mcpTools = Array.isArray(bag['mcp_tools']) ? (bag['mcp_tools'] as Json[]) : []
  for (const raw of mcpTools) {
    const outcome = await normalizeInvokeTool(raw, 'mcp', true, schema)
    if (outcome.entry !== null) push(outcome.entry, null)
    else push(null, { name: nameOf(raw), code: 'bad_tool_decl', message: outcome.message })
  }

  return { tools, byName: new Map(tools.map((entry) => [entry.name, entry])), rejected }
}

/** 绑定表归一：接受 `{<tool>: item}` 或 `{bindings: {...}}` 两种包装。 */
export function normalizeBindings(raw: Json | undefined): Map<string, Rec> {
  const out = new Map<string, Rec>()
  if (!isRecord(raw)) return out
  const source = isRecord(raw['bindings']) ? (raw['bindings'] as Rec) : raw
  for (const [name, item] of Object.entries(source)) {
    if (name === 'reads' || name === 'bindings') continue
    if (isRecord(item)) out.set(name, item)
  }
  return out
}

interface NormalizeOutcome {
  entry: ToolEntry | null
  message: string
}

function nameOf(raw: Json): string {
  if (isRecord(raw) && typeof raw['name'] === 'string') return raw['name'] as string
  return ''
}

/** 校验 describe/invoke 工具声明（外部 MCP 工具 lenient：四要素缺项不拒、argsSchema 净化）。 */
async function normalizeInvokeTool(
  raw: Json,
  provider: string,
  lenient: boolean,
  schema: SchemaBackend,
): Promise<NormalizeOutcome> {
  if (!isRecord(raw)) return { entry: null, message: 'tool declaration must be an object' }
  const name = raw['name']
  if (typeof name !== 'string' || name.length === 0) {
    return { entry: null, message: 'tool name must be a non-empty string' }
  }
  if (!lenient) {
    const elementError = checkElements(raw)
    if (elementError !== null) return { entry: null, message: elementError }
  }

  const declOutcome = await schema.normalizeDecl(raw['argsSchema'], lenient)
  if (!declOutcome.ok) return { entry: null, message: declOutcome.message }
  const argsSchema = declOutcome.schema
  if (!lenient) {
    const coverage = checkParamCoverage(raw, argsSchema)
    if (coverage !== null) return { entry: null, message: coverage }
  }

  const capsOutcome = await schema.normalizeCaps(raw['caps'], lenient)
  if (!capsOutcome.ok) return { entry: null, message: capsOutcome.message }

  const idempotent =
    typeof raw['idempotent'] === 'boolean' ? (raw['idempotent'] as boolean) : lenient ? false : null
  if (idempotent === null) return { entry: null, message: 'idempotent must be a boolean' }

  const merged = mergeParamSemantics(argsSchema, raw['param_semantics'])
  const hidden = hiddenParamsOf(raw)
  const render = isRecord(raw['render']) ? (raw['render'] as Rec) : null
  const decl: Rec = {
    ...raw,
    name,
    provider,
    kind: 'invoke',
    method: null,
    read: null,
    description: descriptionOf(
      raw,
      merged.residual.filter(([key]) => !hidden.has(key)),
    ),
    // 模型可见 schema 摘掉调用方注入参数；校验仍用完整 schema（validateSchema，仅在确有隐藏项时随声明下发）。
    argsSchema: hideParams(merged.schema, hidden),
    caps: (capsOutcome.caps ?? DEFAULT_CAPS) as Json,
    idempotent,
  }
  if (hidden.size > 0) decl['validateSchema'] = merged.schema
  delete decl['hidden_params']
  if (render === null) delete decl['render']
  return { entry: { name, provider, kind: 'invoke', method: null, read: null, decl }, message: '' }
}

/** 校验能力类工具绑定：四要素齐备、class 已 pin、argsSchema 白名单子集、caps 形状合法。 */
async function normalizeBinding(
  name: string,
  item: Rec,
  pins: string[],
  schema: SchemaBackend,
): Promise<NormalizeOutcome> {
  if (name.length === 0) return { entry: null, message: 'binding tool name must be non-empty' }
  const provider = item['class']
  if (typeof provider !== 'string' || provider.length === 0) {
    return { entry: null, message: 'binding class is required' }
  }
  if (!pins.includes(provider)) {
    return { entry: null, message: `binding class ${provider} is not pinned` }
  }
  const methodRaw = item['method']
  if (
    methodRaw !== undefined &&
    methodRaw !== null &&
    (typeof methodRaw !== 'string' || methodRaw.length === 0)
  ) {
    return { entry: null, message: 'binding method must be a non-empty string or null' }
  }
  const method = typeof methodRaw === 'string' ? methodRaw : null

  const elementError = checkElements(item)
  if (elementError !== null) return { entry: null, message: elementError }

  const declOutcome = await schema.normalizeDecl(item['argsSchema'], false)
  if (!declOutcome.ok) return { entry: null, message: declOutcome.message }
  const coverage = checkParamCoverage(item, declOutcome.schema)
  if (coverage !== null) return { entry: null, message: coverage }

  const capsOutcome = await schema.normalizeCaps(item['caps'], false)
  if (!capsOutcome.ok) return { entry: null, message: capsOutcome.message }
  if (typeof item['idempotent'] !== 'boolean') {
    return { entry: null, message: 'idempotent must be a boolean' }
  }
  const readRaw = item['read']
  if (readRaw !== undefined && readRaw !== null && typeof readRaw !== 'string') {
    return { entry: null, message: 'binding read must be a string' }
  }
  const read = typeof readRaw === 'string' ? readRaw : null

  const render = isRecord(item['render']) ? (item['render'] as Rec) : null
  const merged = mergeParamSemantics(declOutcome.schema, item['param_semantics'])
  const hidden = hiddenParamsOf(item)
  const decl: Rec = {
    name,
    provider,
    kind: 'binding',
    method,
    read,
    intent: item['intent'] ?? null,
    when_to_use: item['when_to_use'] ?? null,
    param_semantics: item['param_semantics'] ?? {},
    boundaries: item['boundaries'] ?? null,
    description: descriptionOf(
      item,
      merged.residual.filter(([key]) => !hidden.has(key)),
    ),
    // 模型可见 schema 摘掉调用方注入参数；校验仍用完整 schema（validateSchema，仅在确有隐藏项时随声明下发）。
    argsSchema: hideParams(merged.schema, hidden),
    caps: (capsOutcome.caps ?? DEFAULT_CAPS) as Json,
    idempotent: item['idempotent'] as boolean,
  }
  if (hidden.size > 0) decl['validateSchema'] = merged.schema
  if (render !== null) decl['render'] = render
  return { entry: { name, provider, kind: 'binding', method, read, decl }, message: '' }
}

/** 四要素硬要求：intent / when_to_use / boundaries 非空字符串，param_semantics 为对象。 */
function checkElements(raw: Rec): string | null {
  for (const key of ELEMENTS) {
    const value = raw[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `missing ${key}`
    }
  }
  if (!isRecord(raw['param_semantics'])) return 'missing param_semantics'
  return null
}

/** param_semantics 的键必须覆盖 argsSchema.required。 */
function checkParamCoverage(raw: Rec, argsSchema: Json): string | null {
  if (!isRecord(argsSchema)) return null
  const required = Array.isArray(argsSchema['required']) ? (argsSchema['required'] as Json[]) : []
  const semantics = isRecord(raw['param_semantics']) ? (raw['param_semantics'] as Rec) : {}
  for (const key of required) {
    if (typeof key === 'string' && !Object.hasOwn(semantics, key)) {
      return `param_semantics missing required param ${key}`
    }
  }
  return null
}

/**
 * 把 `param_semantics` 逐项并入 `argsSchema` 对应属性的 `description`：语义就地挂在参数上，
 * 与 `description` 里的散文说明去重（同一段文案只出现一次）。`param_semantics` 覆盖同名属性的
 * `description`，是参数文案的唯一来源，故提供者不应再自带该属性的 `description`（会被覆盖丢弃）。
 * 返回合并后的 schema 与
 * **未覆盖键**（`param_semantics` 有、schema 无对应属性——如纯 `additionalProperties` 的外部工具），
 * 未覆盖键仍回落到 `description` 的 `参数：` 行，信息不丢。
 */
function mergeParamSemantics(
  schema: Json,
  rawSemantics: Json | undefined,
): { schema: Json; residual: [string, Json][] } {
  const entries = isRecord(rawSemantics) ? Object.entries(rawSemantics as Rec) : []
  if (entries.length === 0) return { schema, residual: [] }
  if (!isRecord(schema)) return { schema, residual: entries }
  const properties = isRecord(schema['properties']) ? (schema['properties'] as Rec) : null
  if (properties === null) return { schema, residual: entries }
  const merged: Rec = { ...properties }
  const residual: [string, Json][] = []
  for (const [key, value] of entries) {
    const child = properties[key]
    const text = typeof value === 'string' ? value.trim() : canonicalJson(value)
    if (isRecord(child) && text.length > 0) {
      merged[key] = { ...child, description: text }
      continue
    }
    residual.push([key, value])
  }
  return { schema: { ...schema, properties: merged }, residual }
}

/**
 * 调用方注入参数（`hidden_params`）：这些参数由系统在派发前填好、模型不该也不能填，
 * 故从**模型可见** `argsSchema` 里摘掉（连 `required` 一并摘），但保留在 `validateSchema` 里供派发校验，
 * 使其可由调用方随 args 注入而不被拒。文案 / 文档仍住 `param_semantics`。
 */
function hiddenParamsOf(raw: Rec): Set<string> {
  const value = raw['hidden_params']
  if (!Array.isArray(value)) return new Set()
  return new Set(
    value.filter((item): item is string => typeof item === 'string' && item.length > 0),
  )
}

/** 摘掉隐藏参数后的模型可见 schema（属性与 `required` 同摘；无隐藏项时原样返回）。 */
function hideParams(schema: Json, hidden: Set<string>): Json {
  if (hidden.size === 0 || !isRecord(schema)) return schema
  const properties = isRecord(schema['properties']) ? (schema['properties'] as Rec) : null
  if (properties === null) return schema
  const kept: Rec = {}
  for (const [key, value] of Object.entries(properties)) if (!hidden.has(key)) kept[key] = value
  const out: Rec = { ...schema, properties: kept }
  if (Array.isArray(schema['required'])) {
    const required = (schema['required'] as Json[]).filter(
      (key) => typeof key !== 'string' || !hidden.has(key),
    )
    if (required.length > 0) out['required'] = required
    else delete out['required']
  }
  return out
}

/**
 * 模型可见文本：由四要素机械拼装（短描述 / 使用时机 / 残余参数 / 边界）。
 * `description` 只作首行摘要（提供者直给），不再短路四要素——`when_to_use` / `boundaries` 是模型判断
 * 「何时用、边界在哪」的关键，必须进上下文；`param_semantics` 的「怎么用」已并入 `argsSchema`
 * 各属性的 `description`（见 `mergeParamSemantics`），仅未覆盖键在这里以 `参数：` 回落到正文，避免重复。
 * 文案须为任务级自然语言，不得含插件名 / 能力类名 / 函数名等内部标识符（见各提供者 schema）。
 */
function descriptionOf(raw: Rec, residual: [string, Json][]): string {
  const given = typeof raw['description'] === 'string' ? raw['description'].trim() : ''
  const intent = typeof raw['intent'] === 'string' ? raw['intent'].trim() : ''
  const when = typeof raw['when_to_use'] === 'string' ? raw['when_to_use'].trim() : ''
  const semantics = residual
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : canonicalJson(value)}`)
    .join('; ')
  const boundaries = typeof raw['boundaries'] === 'string' ? raw['boundaries'].trim() : ''
  const lead = given.length > 0 ? given : intent
  return [
    lead,
    when.length > 0 && when !== lead ? `使用时机：${when}` : '',
    semantics.length > 0 ? `参数：${semantics}` : '',
    boundaries.length > 0 ? `边界：${boundaries}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}
