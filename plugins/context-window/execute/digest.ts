// 工具结果摘要（digest）与资源身份：为分层保留与替代去重提供「摘要 + 句柄」的来源。
//
// 摘要优先取提供方随结果自带的 `digest`（工具插件声明产出）；未提供时由结果形状确定派生，
// 使上下文引擎无需认识每个工具的语义。资源身份由参数声明式推导（同样不依赖工具语义）：
// path / url / file → 该字段；shell → cmd + cwd；grep / glob → pattern + base。
// 同输入同输出，不取时间、不随机。

import { isRecord, stableStringify } from './text.ts'
import type { Json } from './types.ts'

/** 资源身份候选键（按序取首个非空字符串）。 */
const IDENTITY_KEYS = ['path', 'file', 'url', 'uri', 'resource'] as const
/** 读取窗口键：同一资源的不同分片是不同内容，纳入身份以免被替代去重误塌。 */
const WINDOW_KEYS = ['offset', 'limit'] as const
/** shell 命令键。 */
const COMMAND_KEYS = ['cmd', 'command'] as const
/** shell 工作目录键。 */
const CWD_KEYS = ['cwd', 'workdir', 'working_dir', 'working_directory'] as const
/** 检索模式键。 */
const PATTERN_KEYS = ['pattern', 'query'] as const
/** 检索基准键。 */
const BASE_KEYS = ['path', 'base', 'glob', 'dir'] as const
/** 计数候选键（数组长度或数字，按序取首个命中）。 */
const COUNT_KEYS = [
  'lines',
  'lines_returned',
  'items',
  'results',
  'matches',
  'hits',
  'entries',
  'paths',
  'files',
  'total',
  'total_lines',
  'count',
] as const
/** 文本候选键（结果正文，按序取首个非空字符串）。 */
const TEXT_KEYS = ['content', 'text', 'output', 'stdout', 'body', 'message', 'summary'] as const
/** 变更类结果键：出现即视为写操作，不参与替代去重（改写历史会丢事实）。 */
const MUTATION_KEYS = ['bytes_written', 'added', 'removed', 'patch', 'created', 'replaced', 'deleted'] as const
/** 变更类工具名（词边界匹配）：不参与替代去重。 */
const MUTATION_TOOL_RE = /(^|[.\-_])(write|edit|delete|remove|move|rename|create|mkdir|touch|append|patch)([.\-_]|$)/i

export interface ResourceIdentity {
  /** 规范化键：`<tool>\u0001<字段>\u0001<值>`（含工具名，两次不同工具的读取不互相替代）。 */
  key: string
  /** 展示字段：如 `{ path: "src/a.ts" }` / `{ cmd, cwd }`。 */
  fields: Record<string, string>
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * 由工具名与调用参数推导资源身份。识别不到（自由参数 / 无资源概念）返回 null，
 * 此时该调用不参与替代去重。
 */
export function resourceIdentity(tool: string, args: Json): ResourceIdentity | null {
  if (!isRecord(args)) return null
  const command = firstString(args, COMMAND_KEYS)
  if (command !== null) {
    const cwd = firstString(args, CWD_KEYS)
    const fields: Record<string, string> = { cmd: command }
    if (cwd !== null) fields['cwd'] = cwd
    return { key: `${tool}\u0001cmd\u0001${command}\u0001${cwd ?? ''}`, fields }
  }
  // 检索类先于普通资源字段判定：`grep` / `glob` 常同时带 `pattern` 与 `path`，
  // 若先命中 `path` 会把不同模式归成同一身份（塌缩掉不同检索的读取）。模式 + 基准才是其资源身份。
  const pattern = firstString(args, PATTERN_KEYS)
  if (pattern !== null) {
    const base = firstString(args, BASE_KEYS)
    const fields: Record<string, string> = { pattern }
    if (base !== null) fields['base'] = base
    return { key: `${tool}\u0001pattern\u0001${pattern}\u0001${base ?? ''}`, fields }
  }
  for (const field of IDENTITY_KEYS) {
    const value = args[field]
    if (typeof value === 'string' && value.length > 0) {
      const window = windowOf(args)
      // 无窗口时键保持不变（旧身份稳定）；带 offset/limit 的读取是不同分片，另成一键。
      if (window === null) return { key: `${tool}\u0001${field}\u0001${value}`, fields: { [field]: value } }
      return {
        key: `${tool}\u0001${field}\u0001${value}\u0001${window.key}`,
        fields: { [field]: value, ...window.fields },
      }
    }
  }
  return null
}

/** 读取窗口（offset/limit）：缺省返回 null，使无窗口的旧身份键保持稳定。 */
function windowOf(args: Record<string, unknown>): { key: string; fields: Record<string, string> } | null {
  const fields: Record<string, string> = {}
  for (const key of WINDOW_KEYS) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = String(value)
  }
  const present = WINDOW_KEYS.filter((key) => fields[key] !== undefined)
  if (present.length === 0) return null
  return { key: present.map((key) => `${key}=${fields[key]}`).join('\u0001'), fields }
}

/** 是否变更类结果：写 / 编辑 / 删除等改写资源，替代去重会丢事实，跳过。 */
export function isMutableResult(tool: string, result: Json, ok: boolean): boolean {
  if (!ok) return false
  if (MUTATION_TOOL_RE.test(tool)) return true
  if (isRecord(result)) {
    for (const key of MUTATION_KEYS) if (result[key] !== undefined) return true
  }
  return false
}

export interface ToolDigest {
  /** 一行摘要文本（提供方 digest 的可读形式，或由形状派生的「N 行 / X KB」）。 */
  summary: string
  /** 规模（行 / 条数）；未知为 null。 */
  count: number | null
  /** 序列化字节数。 */
  bytes: number
  /** 提供方自带的结构化 digest；未提供为 null。 */
  provider: Json | null
  /** 结果正文（供截断尾部取用）；无正文为 null。 */
  text: string | null
}

interface ResultShape {
  count: number | null
  text: string | null
  chars: number
}

/** 从结果值提取确定形状：规模、正文、序列化字符数；不认识的对象退回键清单。 */
function shapeOf(result: Json): ResultShape {
  if (typeof result === 'string') return { count: null, text: result, chars: result.length }
  if (Array.isArray(result)) {
    const serialized = stableStringify(result)
    return { count: result.length, text: serialized, chars: serialized.length }
  }
  if (isRecord(result)) {
    let count: number | null = null
    for (const key of COUNT_KEYS) {
      const value = result[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        count = value
        break
      }
      if (Array.isArray(value)) {
        count = value.length
        break
      }
    }
    let text: string | null = null
    for (const key of TEXT_KEYS) {
      const value = result[key]
      if (typeof value === 'string') {
        text = value
        break
      }
    }
    const serialized = stableStringify(result)
    return { count, text, chars: serialized.length }
  }
  const serialized = stableStringify(result)
  return { count: null, text: null, chars: serialized.length }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10}KB`
}

/** 提供方随结果自带的 digest（对象形态）。 */
function providerDigest(result: Json): Json | null {
  if (isRecord(result) && isRecord(result['digest'])) return result['digest'] as Json
  return null
}

/**
 * 工具结果摘要：优先提供方 `digest`，否则由形状派生规模与正文，
 * 汇总成一行摘要（如 `100 行 / 1.2KB`）。`ok=false` 时摘要退化为错误提示。
 */
export function digestOf(result: Json, ok: boolean): ToolDigest {
  const shape = shapeOf(result)
  const bytes = Buffer.byteLength(typeof result === 'string' ? result : stableStringify(result), 'utf8')
  const provider = providerDigest(result)
  if (!ok) {
    const code = isRecord(result) ? result['code'] ?? result['error'] : result
    const summary = typeof code === 'string' && code.length > 0 ? `error: ${code}` : 'error'
    return { summary, count: shape.count, bytes, provider, text: shape.text }
  }
  const size = formatBytes(bytes)
  const summary = shape.count === null ? size : `${shape.count} 行 / ${size}`
  return { summary, count: shape.count, bytes, provider, text: shape.text }
}
