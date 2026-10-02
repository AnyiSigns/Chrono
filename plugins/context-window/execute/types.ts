// `context-window` 服务内部类型：协议帧、调用帧 env、规范消息模型、policy、bag。
// 规范消息模型（字段名用 camelCase，方言化后才落厂商字段名）。

/** 内核口径的 JSON 值（协议帧载荷）。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 协议帧 `env`（宿主注入）：事件载荷的 run/thread 与 TTL 判定一律用它，服务不取时间。 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

/**
 * 组装来源（优先级与前缀排序都按它分段）。内建 7 类语义固定；外部 `context-source` 贡献方可
 * 自报任意来源名（`string & {}` 保留字面量补全），其保留与排序由 `stability` / `priority` 决定。
 */
export type Source =
  | 'prompt'
  | 'tools'
  | 'input'
  | 'skill'
  | 'history'
  | 'style'
  | 'tool'
  | (string & {})

/** 内建来源名（配额 / 分节 / 保留阶梯按它们固定处理）。 */
export const KNOWN_SOURCES = ['prompt', 'tools', 'input', 'skill', 'history', 'style', 'tool'] as const

/** 是否内建来源：外部来源按稳定性走通用保留 / 排序路径。 */
export function isKnownSource(source: string): boolean {
  return (KNOWN_SOURCES as readonly string[]).includes(source)
}

/** 来源稳定性：稳定来源进可缓存前缀，动态来源不得混入稳定前缀。 */
export type Stability = 'stable' | 'dynamic'

/** 消息角色。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/**
 * 厂商中立的缓存提示（由 model-protocol 消费）：断点是稳定前缀末尾在返回消息数组中的下标；
 * `key` 是稳定前缀的稳定哈希，供带键前缀缓存（`prompt_cache_key`）路由到同一缓存分片。
 */
export interface CacheHint {
  breakpoints?: number[]
  system?: boolean
  tools?: boolean
  key?: string
}

/** 二进制资产引用（只传引用，不进组装字节）。 */
export interface AssetRef {
  sha256: string
  mime: string
  size?: number
}

/** 规范消息的 content part。 */
export type CanonicalPart =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio' | 'file'; asset: AssetRef; name: string | null }

/**
 * 厂商中立的不透明推理块。装配只原样携带，`payload` / `signature` / `encrypted`
 * 一律不得改写或截断；编成哪家线格式由模型层决定。字段形状固定，不增不减。
 */
export interface NeutralReasoning {
  provider: string
  model: string
  form: 'text' | 'blocks'
  payload: string
  signature: string
  encrypted: string
  tokens: number
}

/**
 * 工具结果元数据：保留生成老化摘要所需的原始信息。
 * 老化时由 `ageResultText` 依 (工具, 调用, 资源身份) 产出确定性句柄，供后续展开工具重取完整结果。
 */
export interface ToolResultMeta {
  tool: string
  args: Json
  verbatim: string
}

/**
 * 保留等级（按回合距离，不按消息条数）：
 * `T0` 当前回合逐字；`T1` 近期回合（结果 → 摘要 + 句柄）；`T2` 陈旧回合（结果丢弃、句柄保留）。
 */
export type RetentionTier = 'T0' | 'T1' | 'T2'

/** 结构化候选（汇集阶段产物，尚未计数 / 去重）。 */
export interface RawMessage {
  role: Role
  parts: CanonicalPart[]
  source: Source
  priority: number
  at: number
  atomic: boolean
  atomicGroup: number | null
  toolCallId: string | null
  /** assistant 消息携带的工具调用（中性形状 `[{id,name,arguments}]`）；由协议层按方言编形。 */
  toolCalls?: Json | null
  /** assistant 消息携带的厂商中立推理块（仅当前回合回灌；跨回合默认丢弃）。 */
  reasoning?: NeutralReasoning | null
  /** 工具结果消息的老化元数据；同回合结果可据此按预算阶梯老化。 */
  toolResult?: ToolResultMeta | null
  /** 追加的辅助提示（交错引导），单独计入 `hints` 分节。 */
  hint?: boolean
  /** 系统错误文本（消息 `meta.error`）：T0 逐字、T1+ 一行。 */
  error?: string | null
  from: string | null
  orderHint: number
  /** 消息 def 键（历史 = ref 哈希；合成消息缺省）：规范化缓存键。 */
  defKey?: string | null
  /** 所属回合 id（历史消息由 `session.turns` 还原；同回合 iter 产物缺省 null）。 */
  turnId?: string | null
  /** 落账步号（回合日志的 `seq`；缺省 null）。 */
  step?: number | null
  /** 分层保留等级（由保留阶段赋值；未参与保留的消息缺省 null）。 */
  tier?: RetentionTier | null
  /**
   * 计数 / 规范化缓存键覆盖：parts 相对 def 内容被改写（如 group 线程给历史加发言者前缀）时，
   * 用改写后 parts 的 `computeTokenKey` 定键，保证键与计数输入同口径，避免与未改写形态串计数。
   */
  tokenKey?: string | null
  /**
   * 来源稳定性：内建来源由装配器按 policy 前缀边界自报，外部 `context-source` 记录由贡献方自报。
   * `stable` 进可缓存前缀并作 P0 强制保留；`dynamic` 不混入前缀、可被预算裁剪。
   */
  stability?: Stability | null
}

/**
 * 中性上下文记录：`context-source` 扩展类 `collect` 的返回元素（调用方经 `bag.context_sources` 汇集）。
 * 贡献方只声明事实（来源 / 角色 / 内容 / 稳定性），不改装配器代码；装配器按记录机械转为候选消息。
 * 内建 7 类来源由 context-window 内置默认 contributor 产出同形记录。
 */
export interface ContextRecord {
  /** 来源名：内建 7 类之一复用既有保留 / 分节语义；其余任意名走通用路径。 */
  source: string
  role: Role
  parts: CanonicalPart[]
  /** 数值越小越优先、越不可裁（与内建 PRIORITY 同口径）。 */
  priority: number
  stability: Stability
  atomic?: boolean
  /** 配对 / 保留用的原子组号（历史工具调用 + 结果同组）；外部贡献通常缺省。 */
  atomicGroup?: number | null
  at?: number
  from?: string | null
  orderHint?: number
  toolCallId?: string | null
  toolCalls?: Json | null
  reasoning?: NeutralReasoning | null
  toolResult?: ToolResultMeta | null
  hint?: boolean
  error?: string | null
  defKey?: string | null
  turnId?: string | null
  step?: number | null
  tokenKey?: string | null
}

/** 规范消息（结构化 + 计数后的组装单元）。 */
export interface CanonicalMessage extends RawMessage {
  tokens: number
  /** 推理块 token（已含在 `tokens` 内，单独记以便分节明细）。 */
  reasoningTokens: number
  /** 工具调用 token（已含在 `tokens` 内，单独记以便分节明细）。 */
  toolCallTokens: number
  dedupKey: string
  /** 计数缓存键：历史 = def 哈希；合成消息 = 原始内容键（见 `computeTokenKey`）。 */
  cacheKey: string
  /** 仅规范化内容（不含角色）。 */
  contentKey: string
}

// 预算来源 / 预算模型 / 用量形状的横切契约单源在 `chain-contract`（与提供方 `budget` 共用），
// 见本文件末尾 re-export；此处不再本地复述。

/** policy 预算段。 */
export interface BudgetPolicy {
  margin_ratio: number
  default_context_window: number
  default_max_output: number
}

/** policy 配额段（占预算的比例；未用额度下滚给历史）。 */
export interface QuotaPolicy {
  skill: number
  style: number
}

/** policy 前缀缓存边界。 */
export interface PrefixPolicy {
  stable: Source[]
  order: Source[]
}

/** policy 分层保留参数。 */
export interface RetentionPolicy {
  /** T1 近期回合数（N）；距离小于 N 的回合逐字保留，其余按 T2 保留。 */
  recent_turns: number
  /** 大产物字节阈值：达到即以「摘要 + 句柄」表示而非内联。 */
  large_artifact_bytes: number
  /** 用户消息超大粘贴阈值（码点）：达到即首尾 + 句柄替代，逐层生效；0 = 关闭。 */
  oversized_user_chars: number
}

/** policy 追加文案（环境节 / 交错引导语 / 输入截断标记 / 错误分层）。 */
export interface MessagePolicy {
  /** 稳定「环境」节模板：占位 `{workspace_root}` / `{platform}`；无工作目录时不注入。 */
  environment: string
  interleave_guidance: string
  input_truncated: string
  /** T1 系统错误的一行形态（占位 `{error}`）。 */
  error_line: string
}

/** policy 多模态降级模板：`{kind}` / `{name}` / `{mime}` 占位。 */
export interface ModalityPolicy {
  text_template: string
}

/** 组装策略（住 schema/policy.json，启动与 reload 时读取）。 */
export interface Policy {
  version: number
  budget: BudgetPolicy
  quota: QuotaPolicy
  prefix: PrefixPolicy
  retention: RetentionPolicy
  messages: MessagePolicy
  modality_fallback: ModalityPolicy
}

/** 分节 token 明细（manifest / 事件载荷；覆盖系统提示到提示语的每一段）。 */
export interface SectionTokens {
  system: number
  tools: number
  rules: number
  history_text: number
  tool_calls: number
  tool_results: number
  reasoning: number
  input: number
  hints: number
}

/** 方法返回值与上行事件。 */
export interface BuildResult {
  value: Json
  events: { topic: string; payload: Json }[]
}

/** 组装清单（事件载荷 / 返回值 manifest）。 */
export interface AssemblyManifest {
  run: string | null
  thread: string | null
  model: string
  budget: number
  used: number
  sections: SectionTokens
  sources: Record<string, { tokens: number; count: number }>
  deduped: number
  /** 分层保留计数：各等级（含替代去重塌缩）的消息条数。 */
  retention: Record<RetentionTier, number>
  trimmed: { source: string; reason: string }[]
  degraded: string[]
  flags: string[]
  budget_origin: BudgetOrigin
  usage: UsageManifest | null
}

export { BadArgsError } from 'plugin-sdk'
export type { BudgetModel, BudgetOrigin, QuotaCaps, UsageManifest } from 'chain-contract'
