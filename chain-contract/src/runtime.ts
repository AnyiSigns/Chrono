// 横切契约运行子集：值形状、封闭码集、校验器、结局构造器与 cause 包裹助手。
// 自包含：不 import 任何模块、不触网、不取时钟，可随插件世代入世，也可在浏览器半边运行。
// 本文件是生成源：插件内 execute/contract/index.ts 由它加生成头派生，勿直接改生成物。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Rec = { [key: string]: Json }

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 契约版本
// ---------------------------------------------------------------------------

/** 当前主版本，未知主版本由消费方显式拒绝。 */
export const CONTRACT_MAJOR = 1

/** 当前完整版本 `<major>.<minor>`；小版本前向兼容，主版本必须一致。 */
export const CONTRACT_VERSION = '1.0'

// ---------------------------------------------------------------------------
// 封闭码集
// ---------------------------------------------------------------------------

/** 结局归因维度（封闭）：谁导致这次结局。 */
export const ATTRIBUTABLE_TO = [
  'model',
  'tool',
  'guard',
  'approval',
  'graph',
  'owner',
  'transport',
  'budget',
] as const

export type AttributableTo = (typeof ATTRIBUTABLE_TO)[number]

/** 结局种类（封闭）：回合终态。 */
export const OUTCOME_KINDS = ['committed', 'refused', 'cancelled', 'interrupted'] as const

export type OutcomeKind = (typeof OUTCOME_KINDS)[number]

/**
 * 结局层封闭码集：回合归一处自己的码。下游节点的业务码不改名，原样放进 `cause.code`。
 * 既有码一律沿用（`model_not_configured` 不是 `model_unconfigured`）。
 */
export const OUTCOME_CODES = [
  'budget_exceeded',
  'budget_impossible',
  'cancelled',
  'capability_mismatch',
  'contract_version_mismatch',
  'downstream_refusal',
  'empty_slot',
  'interrupted',
  'invalid_contract',
  'loop_unavailable',
  'model_not_configured',
  'model_timeout',
  'no_plan',
  'owner_unavailable',
  'too_many_rounds',
  'transport_failed',
  'turn_busy',
  'workspace_missing',
] as const

export type OutcomeCode = (typeof OUTCOME_CODES)[number]

export function isAttributableTo(value: unknown): value is AttributableTo {
  return typeof value === 'string' && (ATTRIBUTABLE_TO as readonly string[]).includes(value)
}

export function isOutcomeCode(value: unknown): value is OutcomeCode {
  return typeof value === 'string' && (OUTCOME_CODES as readonly string[]).includes(value)
}

export function isOutcomeKind(value: unknown): value is OutcomeKind {
  return typeof value === 'string' && (OUTCOME_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 结局与 cause
// ---------------------------------------------------------------------------

/** 下游错误的包裹：`from` 命名空间化来源，`code` 原样透传，`message` 可选。 */
export interface Cause {
  from: string
  code: string
  message?: string
}

export interface TurnOutcome {
  kind: OutcomeKind
  code: OutcomeCode | null
  attributableTo: AttributableTo | null
  retryable: boolean
  cause: Cause | null
  stop_reason?: string
  message?: string
}

/** 结构化校验结果：失败以结局表达，不抛异常。 */
export type ContractResult<T> = { ok: true; value: T } | { ok: false; outcome: TurnOutcome }

/** 包裹下游错误为 cause；`from` 缺失时回落 `unknown`。 */
export function causeOf(from: string, code: string, message?: string): Cause {
  const cause: Cause = { from: from.length > 0 ? from : 'unknown', code }
  if (typeof message === 'string') cause.message = message
  return cause
}

/**
 * 从 `{ok:false,error:{code,message}}` 形态的下游回帧取 cause，`code` 逐字节原样透传。
 * 形态不符回 null（调用方自行决定是否仍构造结局）。
 */
export function causeFromError(from: string, error: unknown): Cause | null {
  if (!isRecord(error)) return null
  const record = isRecord(error['error']) ? error['error'] : error
  const code = record['code']
  if (typeof code !== 'string' || code.length === 0) return null
  return causeOf(from, code, typeof record['message'] === 'string' ? record['message'] : undefined)
}

function outcomeOf(partial: TurnOutcome): TurnOutcome {
  const outcome: TurnOutcome = {
    kind: partial.kind,
    code: partial.code,
    attributableTo: partial.attributableTo,
    retryable: partial.retryable === true,
    cause: partial.cause,
  }
  if (typeof partial.stop_reason === 'string') outcome.stop_reason = partial.stop_reason
  if (typeof partial.message === 'string') outcome.message = partial.message
  return outcome
}

export interface RefusalInput {
  code: OutcomeCode
  attributableTo: AttributableTo
  retryable?: boolean
  cause?: Cause | null
  message?: string
}

/** 构造 `refused` 结局。 */
export function refused(input: RefusalInput): TurnOutcome {
  return outcomeOf({
    kind: 'refused',
    code: input.code,
    attributableTo: input.attributableTo,
    retryable: input.retryable === true,
    cause: input.cause ?? null,
    ...(typeof input.message === 'string' ? { message: input.message } : {}),
  })
}

/** 构造 `committed` 结局；预算收口带 `stop_reason`。 */
export function committed(options?: { stopReason?: string }): TurnOutcome {
  return outcomeOf({
    kind: 'committed',
    code: null,
    attributableTo: null,
    retryable: false,
    cause: null,
    ...(typeof options?.stopReason === 'string' ? { stop_reason: options.stopReason } : {}),
  })
}

/** 构造 `cancelled` 结局。 */
export function cancelled(options?: { cause?: Cause | null; message?: string }): TurnOutcome {
  return outcomeOf({
    kind: 'cancelled',
    code: 'cancelled',
    attributableTo: 'owner',
    retryable: false,
    cause: options?.cause ?? null,
    ...(typeof options?.message === 'string' ? { message: options.message } : {}),
  })
}

/** 构造 `interrupted` 结局；中断默认可重试。 */
export function interrupted(options?: { cause?: Cause | null; message?: string }): TurnOutcome {
  return outcomeOf({
    kind: 'interrupted',
    code: 'interrupted',
    attributableTo: 'owner',
    retryable: true,
    cause: options?.cause ?? null,
    ...(typeof options?.message === 'string' ? { message: options.message } : {}),
  })
}

/** 未知契约主版本的拒绝结局。 */
export function contractVersionFailure(received: unknown): TurnOutcome {
  return refused({
    code: 'contract_version_mismatch',
    attributableTo: 'owner',
    message: `unsupported contract_version: ${String(received)}`,
  })
}

/** 契约形状非法（未知键 / 字段类型不符）的拒绝结局。 */
export function invalidContract(message: string, cause?: Cause | null): TurnOutcome {
  return refused({ code: 'invalid_contract', attributableTo: 'owner', cause: cause ?? null, message })
}

// ---------------------------------------------------------------------------
// 版本校验
// ---------------------------------------------------------------------------

/**
 * 校验 `contract_version`：`<major>[.<minor>]` 形态，主版本必须等于 `acceptedMajor`。
 * 返回结构化结局；缺失视为未标注版本，按兼容处理由调用方决定。
 */
export function checkContractVersion(
  value: unknown,
  acceptedMajor: number = CONTRACT_MAJOR,
): ContractResult<string> {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
    return { ok: false, outcome: contractVersionFailure(value) }
  }
  const majorText = value.split('.')[0]
  const major = Number.parseInt(majorText, 10)
  if (major !== acceptedMajor) return { ok: false, outcome: contractVersionFailure(value) }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// 结局校验
// ---------------------------------------------------------------------------

function validateCause(value: unknown): ContractResult<Cause> {
  if (!isRecord(value)) return { ok: false, outcome: invalidContract('cause must be an object') }
  const from = value['from']
  const code = value['code']
  if (typeof from !== 'string' || from.length === 0) {
    return { ok: false, outcome: invalidContract('cause.from must be a non-empty string') }
  }
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, outcome: invalidContract('cause.code must be a non-empty string') }
  }
  const message = value['message']
  return { ok: true, value: causeOf(from, code, typeof message === 'string' ? message : undefined) }
}

/** 校验一个结局记录：种类取封闭集，码与归因按种类要求。 */
export function validateOutcome(value: unknown): ContractResult<TurnOutcome> {
  if (!isRecord(value)) return { ok: false, outcome: invalidContract('outcome must be an object') }
  const kind = value['kind']
  if (!isOutcomeKind(kind)) return { ok: false, outcome: invalidContract('outcome.kind is unknown') }

  let cause: Cause | null = null
  if (value['cause'] !== undefined && value['cause'] !== null) {
    const checked = validateCause(value['cause'])
    if (!checked.ok) return checked
    cause = checked.value
  }

  const code = value['code']
  const attributableTo = value['attributableTo']
  const retryable = value['retryable'] === true
  const message = typeof value['message'] === 'string' ? value['message'] : undefined
  const stopReason = typeof value['stop_reason'] === 'string' ? value['stop_reason'] : undefined

  if (kind === 'committed') {
    if (code !== undefined && code !== null) {
      return { ok: false, outcome: invalidContract('committed outcome must not carry code') }
    }
    if (attributableTo !== undefined && attributableTo !== null) {
      return { ok: false, outcome: invalidContract('committed outcome must not carry attributableTo') }
    }
    return { ok: true, value: committed({ stopReason }) }
  }

  if (!isOutcomeCode(code)) {
    return { ok: false, outcome: invalidContract('outcome.code is not in the closed set') }
  }
  if (!isAttributableTo(attributableTo)) {
    return { ok: false, outcome: invalidContract('outcome.attributableTo is not in the closed set') }
  }
  return {
    ok: true,
    value: outcomeOf({
      kind,
      code,
      attributableTo,
      retryable,
      cause,
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
      ...(message !== undefined ? { message } : {}),
    }),
  }
}

// ---------------------------------------------------------------------------
// bag 校验（chat -> loop-policy 的 interpret bag）
// ---------------------------------------------------------------------------

type FieldType = 'object' | 'array' | 'string'

/** interpret bag 恒有键（构造方每次必写）。 */
export const INTERPRET_BAG_REQUIRED = ['input', 'input_body', 'config', 'session', 'thread', 'thread_kind'] as const

/** interpret bag 键 -> 值类型（构造方写出的全部键，含条件键与后续版本键）。 */
export const INTERPRET_BAG_FIELDS: ReadonlyArray<readonly [string, FieldType]> = [
  ['input', 'object'],
  ['input_body', 'object'],
  ['config', 'object'],
  ['session', 'object'],
  ['thread', 'string'],
  ['thread_kind', 'string'],
  ['tier', 'string'],
  ['session_id', 'string'],
  ['workspace_id', 'string'],
  ['workspace_root', 'string'],
  ['graph', 'object'],
  ['evidence', 'object'],
  ['evolution', 'object'],
  ['approval', 'object'],
  ['question', 'object'],
  ['todo', 'object'],
  ['guard_rules', 'object'],
  ['sandbox_tiers', 'object'],
  ['ignore', 'array'],
  ['tools_bindings', 'object'],
  ['mcp_tools', 'array'],
  ['persona', 'string'],
  ['skills', 'array'],
  ['style', 'string'],
  ['system_prompt', 'string'],
  ['tools', 'array'],
  ['new_conversation', 'object'],
  ['resume', 'object'],
  ['contract_version', 'string'],
]

export const INTERPRET_BAG_KEYS: readonly string[] = INTERPRET_BAG_FIELDS.map(([key]) => key)

const FIELD_TYPE_CHECKS: Record<FieldType, (value: unknown) => boolean> = {
  object: (value) => isRecord(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
}

function validateKnownFields(
  value: Rec,
  fields: ReadonlyArray<readonly [string, FieldType]>,
): ContractResult<Rec> {
  for (const [key, type] of fields) {
    const field = value[key]
    if (field === undefined || field === null) continue
    if (!FIELD_TYPE_CHECKS[type](field)) {
      return { ok: false, outcome: invalidContract(`bag.${key} must be ${type}`) }
    }
  }
  return { ok: true, value }
}

export interface ValidateBagOptions {
  /** true = 拒绝契约外的顶层键（契约边界用）；缺省容忍消费方在执行中追加的内部键。 */
  strict?: boolean
}

/**
 * 校验 `loop-policy.interpret` 的 bag：必需键齐备、已知键类型正确、`contract_version` 主版本一致。
 * 失败回结构化结局，不抛异常。
 */
export function validateBag(value: unknown, options?: ValidateBagOptions): ContractResult<Rec> {
  if (!isRecord(value)) return { ok: false, outcome: invalidContract('interpret bag must be an object') }
  for (const key of INTERPRET_BAG_REQUIRED) {
    if (value[key] === undefined) return { ok: false, outcome: invalidContract(`bag.${key} is required`) }
  }
  const typed = validateKnownFields(value, INTERPRET_BAG_FIELDS)
  if (!typed.ok) return typed
  if (value['contract_version'] !== undefined && value['contract_version'] !== null) {
    const version = checkContractVersion(value['contract_version'])
    if (!version.ok) return version
  }
  if (options?.strict === true) {
    const known = new Set(INTERPRET_BAG_KEYS)
    for (const key of Object.keys(value)) {
      if (!known.has(key)) return { ok: false, outcome: invalidContract(`bag.${key} is not a contract key`) }
    }
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// 回合步记录校验
// ---------------------------------------------------------------------------

export const STEP_RECORD_TYPES = [
  'turn.open',
  'step.intent',
  'step.result',
  'step.user',
  'checkpoint',
  'turn.settle',
] as const

type StepRecordType = (typeof STEP_RECORD_TYPES)[number]

interface StepRecordSpec {
  required: readonly string[]
  fields: ReadonlyArray<readonly [string, FieldType]>
}

const STEP_RECORD_SPECS: Record<StepRecordType, StepRecordSpec> = {
  'turn.open': {
    required: ['turn_id', 'conv', 'user_message', 'slot_ref', 'at'],
    fields: [
      ['turn_id', 'string'],
      ['conv', 'string'],
      ['user_message', 'object'],
      ['slot_ref', 'string'],
      ['at', 'string'],
    ],
  },
  'step.intent': {
    required: ['turn_id', 'seq', 'kind', 'tool_calls'],
    fields: [
      ['turn_id', 'string'],
      ['kind', 'string'],
      ['tool_calls', 'array'],
    ],
  },
  'step.result': {
    required: ['turn_id', 'seq'],
    fields: [
      ['turn_id', 'string'],
      ['assistant', 'object'],
      ['tool_results', 'array'],
      ['reasoning', 'object'],
      ['usage', 'object'],
    ],
  },
  'step.user': {
    required: ['turn_id', 'seq', 'user_message'],
    fields: [
      ['turn_id', 'string'],
      ['user_message', 'object'],
      ['insert_id', 'string'],
    ],
  },
  checkpoint: {
    required: ['turn_id', 'seq', 'summary', 'covered_upto'],
    fields: [
      ['turn_id', 'string'],
      ['summary', 'object'],
    ],
  },
  'turn.settle': {
    required: ['turn_id', 'outcome'],
    fields: [['turn_id', 'string']],
  },
}

function isStepRecordType(value: unknown): value is StepRecordType {
  return typeof value === 'string' && (STEP_RECORD_TYPES as readonly string[]).includes(value)
}

/**
 * 覆盖边界：字符串（历史 message id）/ 整数（旧式、局部于检查点自身回合）/
 * `{turn_id, seq}`（全局边界，按回合序 + 步号词序）。
 */
export function isCoverageBoundary(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (Number.isInteger(value)) return true
  if (isRecord(value)) {
    return typeof value['turn_id'] === 'string' && Number.isInteger(value['seq'])
  }
  return false
}

/** 校验一条回合步记录（`type` 取步记录名）。失败回结构化结局，不抛异常。 */
export function validateStepRecord(value: unknown): ContractResult<Rec> {
  if (!isRecord(value)) return { ok: false, outcome: invalidContract('step record must be an object') }
  const type = value['type']
  if (!isStepRecordType(type)) return { ok: false, outcome: invalidContract('step record type is unknown') }
  const spec = STEP_RECORD_SPECS[type]
  for (const key of spec.required) {
    if (value[key] === undefined) {
      return { ok: false, outcome: invalidContract(`${type}.${key} is required`) }
    }
  }
  const typed = validateKnownFields(value, spec.fields)
  if (!typed.ok) return typed
  if (value['seq'] !== undefined && !Number.isInteger(value['seq'])) {
    return { ok: false, outcome: invalidContract(`${type}.seq must be an integer`) }
  }
  if (type === 'checkpoint') {
    if (!isCoverageBoundary(value['covered_upto'])) {
      return {
        ok: false,
        outcome: invalidContract('checkpoint.covered_upto must be a string, integer, or {turn_id, seq}'),
      }
    }
  }
  if (type === 'turn.settle') {
    const outcome = validateOutcome(value['outcome'])
    if (!outcome.ok) return outcome
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// 推理块校验（厂商中立的不透明块）
// ---------------------------------------------------------------------------

export const REASONING_FORMS = ['text', 'blocks'] as const

export type ReasoningForm = (typeof REASONING_FORMS)[number]

export interface ReasoningBlock {
  provider: string
  model: string
  form: ReasoningForm
  payload: Json
  signature?: string | null
  encrypted?: string | null
  tokens?: number
}

/** 校验厂商中立的推理块。失败回结构化结局，不抛异常。 */
export function validateReasoningBlock(value: unknown): ContractResult<ReasoningBlock> {
  if (!isRecord(value)) return { ok: false, outcome: invalidContract('reasoning block must be an object') }
  const provider = value['provider']
  const model = value['model']
  const form = value['form']
  if (typeof provider !== 'string' || provider.length === 0) {
    return { ok: false, outcome: invalidContract('reasoning.provider must be a non-empty string') }
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, outcome: invalidContract('reasoning.model must be a non-empty string') }
  }
  if (form !== 'text' && form !== 'blocks') {
    return { ok: false, outcome: invalidContract('reasoning.form must be text or blocks') }
  }
  if (value['payload'] === undefined) {
    return { ok: false, outcome: invalidContract('reasoning.payload is required') }
  }
  const block: ReasoningBlock = { provider, model, form, payload: value['payload'] as Json }
  if (typeof value['signature'] === 'string' || value['signature'] === null) block.signature = value['signature']
  if (typeof value['encrypted'] === 'string' || value['encrypted'] === null) block.encrypted = value['encrypted']
  if (value['tokens'] !== undefined) {
    if (!Number.isInteger(value['tokens'])) {
      return { ok: false, outcome: invalidContract('reasoning.tokens must be an integer') }
    }
    block.tokens = value['tokens'] as number
  }
  return { ok: true, value: block }
}
