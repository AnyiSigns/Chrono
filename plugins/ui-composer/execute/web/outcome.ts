// 回合结局读值（纯函数）：从命令回执的 `result.value` 取业务结局或回合前拒绝。
//
// 壳对命令回帧恒包 `{ok:true, value}`，失败被藏进 `value`——不读 `value` 就会把失败
// 当成功。业务结局是唯一权威表示：`value.outcome`（`{kind, code, attributableTo,
// retryable, cause, message}`，与 `chat.turn.settled` 同源）。回合前拒绝发生在回合开启
// 之前，不带结局，只有 `value.error.code`，按引导渲染。

export type OutcomeKind = 'committed' | 'refused' | 'cancelled' | 'interrupted'

/** 归因分类（封闭集，与结局契约一致）。 */
export type AttributableTo =
  | 'model'
  | 'tool'
  | 'guard'
  | 'approval'
  | 'graph'
  | 'owner'
  | 'transport'
  | 'budget'

export interface BusinessOutcome {
  kind: OutcomeKind
  code: string | null
  attributableTo: AttributableTo | null
  retryable: boolean
  /** 下游业务码（`cause.code`），原样透传、不改名。 */
  causeCode: string | null
  message: string | null
}

export interface PreTurnRefusal {
  code: string
  message: string
}

const OUTCOME_KINDS: readonly OutcomeKind[] = ['committed', 'refused', 'cancelled', 'interrupted']

/** 回合前拒绝码（发生在 `turn.open` 之前，不持久化、无结局）。 */
const PRE_TURN_CODES: readonly string[] = ['model_not_configured', 'workspace_missing', 'empty_slot']

export function isRecord(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 归一一条结局（形态非法回 null，不构造结局）。 */
export function normalizeOutcome(value: unknown): BusinessOutcome | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  if (typeof kind !== 'string' || !OUTCOME_KINDS.includes(kind as OutcomeKind)) return null
  const cause = isRecord(value.cause) ? value.cause : null
  const attribution = value.attributableTo
  return {
    kind: kind as OutcomeKind,
    code: asString(value.code),
    attributableTo: asString(attribution) as AttributableTo | null,
    retryable: value.retryable === true,
    causeCode: cause !== null ? asString(cause.code) : null,
    message: asString(value.message),
  }
}

/** 从回执值取业务结局（`value.outcome`）。 */
export function parseOutcome(value: unknown): BusinessOutcome | null {
  if (!isRecord(value)) return null
  return normalizeOutcome(value.outcome)
}

/** 从回执值取回合前拒绝（`value.ok === false` 且带 `error`，无结局）。 */
export function parsePreTurnRefusal(value: unknown): PreTurnRefusal | null {
  if (!isRecord(value) || value.ok !== false) return null
  if (isRecord(value.outcome)) return null
  const error = isRecord(value.error) ? value.error : null
  const code = error !== null ? asString(error.code) : null
  if (code === null || error === null) return null
  return { code, message: asString(error.message) ?? '' }
}

/** 是否失败结局（`committed` 之外都是失败，但 **用户主动取消 `cancelled` 不算失败**：静默）。
 *  取消是预期内的用户动作，不应在输入卡按错误提示。 */
export function isFailure(outcome: BusinessOutcome): boolean {
  return outcome.kind !== 'committed' && outcome.kind !== 'cancelled'
}

/** 展示码：结局层码优先，其次 `cause` 里的下游码；无码回 `unknown`。
 *  结局层通用包装 `downstream_refusal` 不吞掉下游具体码——有 `cause` 就展示 `cause`。 */
export function displayCode(outcome: BusinessOutcome): string {
  if (outcome.code === 'downstream_refusal' && outcome.causeCode !== null) return outcome.causeCode
  return outcome.code ?? outcome.causeCode ?? 'unknown'
}

/** 回执渲染视图（I19：UI 不得掩盖失败）。 */
export interface ReceiptView {
  kind: 'none' | 'success' | 'failure' | 'guidance'
  code: string | null
  attributableTo: AttributableTo | null
  retryable: boolean
  /** 失败 / 引导时的展示码：结局码或下游 `cause` 码。 */
  displayCode: string | null
  message: string | null
  /** 引导动作：`settings` = 打开设置页（未配模型）。 */
  action: 'settings' | null
}

const NONE_VIEW: ReceiptView = {
  kind: 'none',
  code: null,
  attributableTo: null,
  retryable: false,
  displayCode: null,
  message: null,
  action: null,
}

/**
 * 命令回执 → 渲染视图。输入是壳回帧（`{ok, value}`）。
 * `ok:true` 只代表回帧到达，业务成败只看 `value`：有 `outcome` 按结局分支，
 * 有 `error` 按回合前引导分支，两者皆无才是无可呈现内容。
 */
export function receiptView(result: unknown): ReceiptView {
  if (!isRecord(result)) return NONE_VIEW
  const value = result.value
  const outcome = parseOutcome(value)
  if (outcome !== null) {
    if (!isFailure(outcome)) {
      return { ...NONE_VIEW, kind: 'success' }
    }
    return {
      kind: 'failure',
      code: outcome.code,
      attributableTo: outcome.attributableTo,
      retryable: outcome.retryable,
      displayCode: displayCode(outcome),
      message: outcome.message,
      action: null,
    }
  }
  const preTurn = parsePreTurnRefusal(value)
  if (preTurn !== null) {
    return {
      kind: 'guidance',
      code: preTurn.code,
      attributableTo: null,
      retryable: true,
      displayCode: preTurn.code,
      message: preTurn.message,
      action: preTurn.code === 'model_not_configured' ? 'settings' : null,
    }
  }
  return NONE_VIEW
}

/** 该码是否为回合前拒绝码（供 store 判定引导分支）。 */
export function isPreTurnCode(code: unknown): boolean {
  return typeof code === 'string' && PRE_TURN_CODES.includes(code)
}
