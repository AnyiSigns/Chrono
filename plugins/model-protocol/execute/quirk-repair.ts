// 4xx 字段协商（quirk 自适应）：同一模型「完整请求 400 / 最小请求通过」时的通用兜底。
// 错误正文点名哪个字段就去掉 / 降级哪个字段后重试一次；正文给不出线索时按固定梯队逐档退让（限次）。
// 只有**真正跑通**的退让才写进记忆（按 provider+base_url+model），避免盲试不成功却永久降级。
// 与「推理降级」同口径：进程内、会话期有效、重启重探；纯逻辑 + 进程内记忆，不触网、不取时钟。

import type { Json, Rec } from 'plugin-sdk'

/** 可协商字段的退让档。 */
export type RepairKind =
  | 'drop_max_tokens'
  | 'drop_stream_options'
  | 'drop_tool_choice'
  | 'drop_tools'
  | 'drop_reasoning_replay'
  | 'drop_reasoning_param'

/**
 * 错误正文给不出字段线索时的退让梯队（保守 → 让路）。
 * 不含 `drop_tools`：盲试降到"去工具"会让 agent 静默失能，只在正文明确点名 tools 字段时才用（见 FIELD_HINTS）。
 */
export const REPAIR_ESCALATION: readonly RepairKind[] = [
  'drop_max_tokens',
  'drop_stream_options',
  'drop_tool_choice',
]

/**
 * 上下文长度超限文案：这类 400 的解法是**下调请求输出**（去 `max_tokens` 让端点用默认），
 * 与 tools 字段无关。必须优先识别，否则正文里的 "tool input" 等字样会被误判成工具字段问题。
 */
const CONTEXT_LENGTH_HINT =
  /maximum context length|context[_\s-]?length|reduce the length|too many tokens|exceeds?[^.]*context|context[^.]*exceed/i

/** 错误正文 -> 退让档：先匹配点名字段；每次只推进一档。 */
const FIELD_HINTS: ReadonlyArray<readonly [RegExp, RepairKind]> = [
  [/max[_\s-]?(?:tokens?|completion[_\s-]?tokens?|output[_\s-]?tokens?)/i, 'drop_max_tokens'],
  [/reasoning|thinking|thought|signature|encrypted/i, 'drop_reasoning_replay'],
  [/stream[_\s-]?options/i, 'drop_stream_options'],
  [/tool[_\s-]?choice/i, 'drop_tool_choice'],
  // 只在真正点名 `tools` 字段时报错时才退让；排除 "tool input/output" 这类描述性短语。
  [/\btools?\b(?!\s*(?:input|output|are|is\b))/i, 'drop_tools'],
]

/**
 * 本次 4xx 该新增哪一档：点名字段优先；该档已应用则顺延到梯队里的下一档。
 * 返回空数组 = 没有可再退让的字段（调用方据此放弃并原样回灌错误）。
 */
export function nextRepairs(message: string, applied: ReadonlySet<RepairKind>): RepairKind[] {
  // 上下文长度超限：只下调请求输出，绝不因正文里的 "tool input" 等字样去动 tools。
  if (CONTEXT_LENGTH_HINT.test(message)) {
    return applied.has('drop_max_tokens') ? [] : ['drop_max_tokens']
  }
  for (const [pattern, kind] of FIELD_HINTS) {
    if (!pattern.test(message)) continue
    if (!applied.has(kind)) return [kind]
    // 推理降级是两段式：先去回传，仍被拒则整套关闭思考。
    if (kind === 'drop_reasoning_replay' && !applied.has('drop_reasoning_param'))
      return ['drop_reasoning_param']
    break
  }
  const next = REPAIR_ESCALATION.find((kind) => !applied.has(kind))
  return next === undefined ? [] : [next]
}

const memo = new Map<string, Set<RepairKind>>()

/** 记忆键：同名字面 vendor 的不同端点 / 同名模型不互相误伤。 */
export function repairKey(provider: string, baseUrl: string, model: string): string {
  return `${provider}\u0000${baseUrl}\u0000${model}`
}

/** 已确认有效的退让档（缺省空集）。 */
export function repairsFor(key: string): Set<RepairKind> {
  return memo.get(key) ?? new Set<RepairKind>()
}

/** 记下确认有效的退让档；返回并集（便于调用方就地复用）。 */
export function rememberRepairs(key: string, kinds: readonly RepairKind[]): Set<RepairKind> {
  const set = memo.get(key) ?? new Set<RepairKind>()
  for (const kind of kinds) set.add(kind)
  memo.set(key, set)
  return set
}

/** 可改写字段子集（ParsedChat / 请求实例的结构化摘取）。 */
export interface RepairableFields {
  params: Rec
  tools: Json | undefined
  tool_choice: Json | undefined
}

/**
 * 按退让档改写请求字段：
 * `drop_max_tokens` 删 `params.max_tokens`（适配器据 `max_tokens_field` 编进请求体）；
 * `drop_tool_choice` / `drop_tools` 删对应字段（去 tools 时一并去 tool_choice，避免悬空）。
 */
export function applyRequestRepairs(
  request: RepairableFields,
  applied: ReadonlySet<RepairKind>,
): RepairableFields {
  const out: RepairableFields = {
    params: request.params,
    tools: request.tools,
    tool_choice: request.tool_choice,
  }
  if (applied.has('drop_max_tokens')) {
    const params = { ...out.params }
    delete params['max_tokens']
    out.params = params
  }
  if (applied.has('drop_tool_choice') || applied.has('drop_tools')) out.tool_choice = undefined
  if (applied.has('drop_tools')) out.tools = undefined
  return out
}

/** `drop_stream_options`：把流式用量合并关掉，适配器据此不发 `stream_options`。 */
export function applyQuirksRepairs<T extends { stream_usage?: Json }>(
  quirks: T,
  applied: ReadonlySet<RepairKind>,
): T {
  if (!applied.has('drop_stream_options')) return quirks
  return { ...quirks, stream_usage: 'none' } as T
}
