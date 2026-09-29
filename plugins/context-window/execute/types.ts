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

/** 组装来源（优先级与前缀排序都按它分段）。 */
export type Source =
  | 'prompt'
  | 'tools'
  | 'input'
  | 'l2'
  | 'l1'
  | 'skill'
  | 'recall'
  | 'history'
  | 'style'
  | 'tool'

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
 * `T0` 当前回合逐字；`T1` 近期回合（结果 → 摘要 + 句柄）；`T2` 陈旧回合（结果丢弃、句柄保留，正文压缩）；
 * `T3` 窗口外（由检查点替代，逐条记录不回灌）。
 */
export type RetentionTier = 'T0' | 'T1' | 'T2' | 'T3'

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
  /** 追加的辅助提示（压缩提示 / 交错引导），单独计入 `hints` 分节。 */
  hint?: boolean
  /** 该消息是否为结构化检查点（分层保留把陈旧错误蒸馏进它的 `errors_to_avoid`）。 */
  checkpoint?: boolean
  /** 系统错误文本（消息 `meta.error`）：T0 逐字、T1 一行、T2+ 蒸馏进检查点。 */
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
  /** 投影层已判定被检查点边界覆盖（保留阶段据此直接落 T3）。 */
  covered?: boolean | null
  /**
   * 计数 / 规范化缓存键覆盖：parts 相对 def 内容被改写（如 group 线程给历史加发言者前缀）时，
   * 用改写后 parts 的 `computeTokenKey` 定键，保证键与计数输入同口径，避免与未改写形态串计数。
   */
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
  /** 仅规范化内容（不含角色）：跨来源去重（记忆 vs 历史丢记忆副本）用。 */
  contentKey: string
}

/** 预算来源：模型档案给出，或缺失时回落 policy 默认值。 */
export type BudgetOrigin = 'profile' | 'default'

/** policy 预算段。 */
export interface BudgetPolicy {
  margin_ratio: number
  default_context_window: number
  default_max_output: number
}

/** policy 配额段（占预算的比例；未用额度下滚给历史）。 */
export interface QuotaPolicy {
  l2: number
  l1: number
  skill: number
  recall: number
  style: number
}

/** policy 前缀缓存边界。 */
export interface PrefixPolicy {
  stable: Source[]
  order: Source[]
}

/** policy 阈值。 */
export interface ThresholdPolicy {
  compress_hint_ratio: number
}

/** policy 分层保留参数。 */
export interface RetentionPolicy {
  /** T1 近期回合数（N）；距离小于 N 的回合逐字保留，其余按 T2 压缩。 */
  recent_turns: number
  /** T2 助手正文压缩后的最大字符数。 */
  t2_text_chars: number
  /** 大产物字节阈值：达到即以「摘要 + 句柄」表示而非内联。 */
  large_artifact_bytes: number
  /** 用户消息超大粘贴阈值（码点）：达到即首尾 + 句柄替代，逐层生效；0 = 关闭。 */
  oversized_user_chars: number
}

/** policy 追加文案（环境节 / 压缩提示 / 交错引导语 / 输入截断标记 / 错误分层）。 */
export interface MessagePolicy {
  /** 稳定「环境」节模板：占位 `{workspace_root}` / `{platform}`；无工作目录时不注入。 */
  environment: string
  compress_hint: string
  interleave_guidance: string
  input_truncated: string
  /** T1 系统错误的一行形态（占位 `{error}`）。 */
  error_line: string
  /** 蒸馏进检查点的错误列表标题（与 `renderCheckpoint` 的 `errors_to_avoid` 同标题）。 */
  error_avoid_header: string
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
  thresholds: ThresholdPolicy
  retention: RetentionPolicy
  messages: MessagePolicy
  modality_fallback: ModalityPolicy
}

/** 分节 token 明细（manifest / 事件载荷；覆盖系统提示到提示语的每一段）。 */
export interface SectionTokens {
  system: number
  tools: number
  rules: number
  l2: number
  checkpoint: number
  history_text: number
  tool_calls: number
  tool_results: number
  reasoning: number
  input: number
  hints: number
}

/** 真实用量解析结果（缓存命中率由此可观测）。 */
export interface UsageManifest {
  prompt_tokens: number
  cached_tokens: number
  cache_creation_tokens: number
  completion_tokens: number
  hit_rate: number | null
  correction_factor: number | null
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
  recall: { entry: string; score: number }[]
  flags: string[]
  budget_origin: BudgetOrigin
  usage: UsageManifest | null
}

export { BadArgsError } from 'plugin-sdk'
