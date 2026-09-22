// 工具目录：本插件 `pins` 的工具提供者并集（describe/invoke 提供者各自 describe + 绑定提供者绑定表）
// + 外部 MCP 工具（调用方随 bag 传入的 #37 投影清单）。做四要素 / argsSchema 白名单 / caps 形状校验
// 与工具名全局唯一性校验；不合规项不进目录（`bad_tool_decl`），并在 rejected 里留诊断。

import { canonicalJson } from './json.ts'
import { toolsOf } from './port-link.ts'
import type { PortLink } from './port-link.ts'
import { defaultCaps, normalizeCaps, sanitizeArgsSchema, validateArgsSchema } from './schema-validate.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 无 describe / invoke 的绑定提供者端口（走能力类方法绑定）。 */
const BINDING_PORTS = new Set(['session', 'compress', 'memory', 'retrieval', 'memory-maintenance', 'evolve-metrics'])

/** 非工具提供者端口（guard 是语义门、host 是保留身份，不参与目录）。 */
const NON_TOOL_PORTS = new Set(['guard', 'host'])

/** 四要素键。 */
const ELEMENTS = ['intent', 'when_to_use', 'boundaries'] as const

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
  bag: Rec
  link: PortLink
}

/** describe/invoke 提供者端口 = pins 去掉绑定提供者与非工具提供者。 */
export function describePorts(pins: string[]): string[] {
  return pins.filter((port) => !BINDING_PORTS.has(port) && !NON_TOOL_PORTS.has(port))
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
 * 构造目录：并发拉全部 describe/invoke 提供者的 `describe`，并入绑定表与外部 MCP 工具，
 * 逐项校验、按工具名去重。提供者 `describe` 不可用（未就绪 / 出错）只跳过该提供者，不阻断目录。
 */
export async function buildDirectory(input: BuildInput): Promise<Directory> {
  const { pins, bag, link } = input
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

  const ports = describePorts(pins)
  const described = await Promise.all(
    ports.map(async (port) => ({ port, value: await link.call(port, 'describe', {}) })),
  )
  for (const { port, value } of described) {
    if (!value.ok) continue
    for (const raw of toolsOf(value.value)) {
      const outcome = normalizeInvokeTool(raw, port, false)
      if (outcome.entry !== null) push(outcome.entry, null)
      else push(null, { name: nameOf(raw), code: 'bad_tool_decl', message: outcome.message })
    }
  }

  const bindings = normalizeBindings(bag['tools_bindings'])
  for (const [name, item] of bindings) {
    const outcome = normalizeBinding(name, item, pins)
    if (outcome.entry !== null) push(outcome.entry, null)
    else push(null, { name, code: 'bad_tool_decl', message: outcome.message })
  }

  const mcpTools = Array.isArray(bag['mcp_tools']) ? (bag['mcp_tools'] as Json[]) : []
  for (const raw of mcpTools) {
    const outcome = normalizeInvokeTool(raw, 'mcp', true)
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
function normalizeInvokeTool(raw: Json, provider: string, lenient: boolean): NormalizeOutcome {
  if (!isRecord(raw)) return { entry: null, message: 'tool declaration must be an object' }
  const name = raw['name']
  if (typeof name !== 'string' || name.length === 0) {
    return { entry: null, message: 'tool name must be a non-empty string' }
  }
  if (!lenient) {
    const elementError = checkElements(raw)
    if (elementError !== null) return { entry: null, message: elementError }
  }

  const argsSchema = lenient ? sanitizeArgsSchema(raw['argsSchema'] ?? { type: 'object' }) : raw['argsSchema']
  if (!lenient) {
    const schemaCheck = validateArgsSchema(argsSchema)
    if (!schemaCheck.ok) return { entry: null, message: schemaCheck.message }
    const coverage = checkParamCoverage(raw, argsSchema)
    if (coverage !== null) return { entry: null, message: coverage }
  }

  const capsResult = normalizeCaps(raw['caps'], lenient)
  if (!capsResult.ok) return { entry: null, message: capsResult.message }

  const idempotent = typeof raw['idempotent'] === 'boolean' ? (raw['idempotent'] as boolean) : lenient ? false : null
  if (idempotent === null) return { entry: null, message: 'idempotent must be a boolean' }

  const render = isRecord(raw['render']) ? (raw['render'] as Rec) : null
  const decl: Rec = {
    ...raw,
    name,
    provider,
    kind: 'invoke',
    method: null,
    read: null,
    description: descriptionOf(raw),
    argsSchema: argsSchema as Json,
    caps: (capsResult.caps ?? defaultCaps()) as Json,
    idempotent,
  }
  if (render === null) delete decl['render']
  return { entry: { name, provider, kind: 'invoke', method: null, read: null, decl }, message: '' }
}

/** 校验能力类工具绑定：四要素齐备、class 已 pin、argsSchema 白名单子集、caps 形状合法。 */
function normalizeBinding(name: string, item: Rec, pins: string[]): NormalizeOutcome {
  if (name.length === 0) return { entry: null, message: 'binding tool name must be non-empty' }
  const provider = item['class']
  if (typeof provider !== 'string' || provider.length === 0) {
    return { entry: null, message: 'binding class is required' }
  }
  if (!pins.includes(provider)) {
    return { entry: null, message: `binding class ${provider} is not pinned` }
  }
  const methodRaw = item['method']
  if (methodRaw !== undefined && methodRaw !== null && (typeof methodRaw !== 'string' || methodRaw.length === 0)) {
    return { entry: null, message: 'binding method must be a non-empty string or null' }
  }
  const method = typeof methodRaw === 'string' ? methodRaw : null

  const elementError = checkElements(item)
  if (elementError !== null) return { entry: null, message: elementError }

  const schemaCheck = validateArgsSchema(item['argsSchema'])
  if (!schemaCheck.ok) return { entry: null, message: schemaCheck.message }
  const coverage = checkParamCoverage(item, item['argsSchema'])
  if (coverage !== null) return { entry: null, message: coverage }

  const capsResult = normalizeCaps(item['caps'], false)
  if (!capsResult.ok) return { entry: null, message: capsResult.message }
  if (typeof item['idempotent'] !== 'boolean') {
    return { entry: null, message: 'idempotent must be a boolean' }
  }
  const readRaw = item['read']
  if (readRaw !== undefined && readRaw !== null && typeof readRaw !== 'string') {
    return { entry: null, message: 'binding read must be a string' }
  }
  const read = typeof readRaw === 'string' ? readRaw : null

  const render = isRecord(item['render']) ? (item['render'] as Rec) : null
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
    description: descriptionOf(item),
    argsSchema: item['argsSchema'] as Json,
    caps: (capsResult.caps ?? defaultCaps()) as Json,
    idempotent: item['idempotent'] as boolean,
  }
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

/** 模型可见文本：提供者可直给；缺省由四要素机械拼装。 */
function descriptionOf(raw: Rec): string {
  const given = raw['description']
  if (typeof given === 'string' && given.trim().length > 0) return given
  const intent = typeof raw['intent'] === 'string' ? raw['intent'] : ''
  const when = typeof raw['when_to_use'] === 'string' ? raw['when_to_use'] : ''
  const semantics = isRecord(raw['param_semantics'])
    ? Object.entries(raw['param_semantics'] as Rec)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : canonicalJson(value)}`)
        .join('; ')
    : ''
  const boundaries = typeof raw['boundaries'] === 'string' ? raw['boundaries'] : ''
  return [
    intent,
    when.length > 0 ? `使用时机：${when}` : '',
    semantics.length > 0 ? `参数：${semantics}` : '',
    boundaries.length > 0 ? `边界：${boundaries}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}
