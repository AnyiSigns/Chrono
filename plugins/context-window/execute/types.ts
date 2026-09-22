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

/** 消息角色。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

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
  from: string | null
  subject: string | null
  orderHint: number
  /** 消息 def 键（历史 = ref 哈希；合成消息缺省）：计数 / 规范化缓存的键。 */
  defKey?: string | null
}

/** 规范消息（结构化 + 计数后的组装单元）。 */
export interface CanonicalMessage extends RawMessage {
  tokens: number
  dedupKey: string
  conflictKey: string
  cacheKey: string
  /** 仅规范化内容（不含角色）：跨来源去重（记忆 vs 历史丢记忆副本）用。 */
  contentKey: string
}

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

/** policy 追加文案（压缩提示 / 交错引导语）。 */
export interface MessagePolicy {
  compress_hint: string
  interleave_guidance: string
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
  messages: MessagePolicy
  modality_fallback: ModalityPolicy
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
  sources: Record<string, { tokens: number; count: number }>
  deduped: number
  trimmed: { source: string; reason: string }[]
  recall: { entry: string; score: number }[]
  flags: string[]
}

/** 参数错误（对应协议 error 帧 `bad_args`）。 */
export class BadArgsError extends Error {}
