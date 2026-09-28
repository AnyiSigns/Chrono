// 解释器生命周期：封闭状态机，与图拓扑无关（换图不改枚举）。
// 状态只能经本文件的转换表变更——生命周期字段的赋值只允许出现在本文件声明的转换函数内（静态扫描强制）。
// 图内进度（iter / node_index / contract_id）是只读数据，随生命周期携带、不参与状态判定。

export const LIFECYCLE_STATES = ['assembled', 'stepping', 'suspended', 'settling', 'settled'] as const

export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

/**
 * 生命周期事件：
 * `step` 进入首段；`segment` 段边界（同 run 下一段）；`suspend` 段尾挂起（approval / question）；
 * `settle` 回合终止（进入唯一写结局的阶段）；`finalize` 落定。
 */
export const LIFECYCLE_EVENTS = ['step', 'segment', 'suspend', 'settle', 'finalize'] as const

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

/** 图内进度（数据，非状态）：UI 按 `contract_id` 映射「正在思考 / 正在调工具」。 */
export interface GraphProgress {
  iter: number
  node_index: number | null
  contract_id: string | null
}

export interface Lifecycle {
  state: LifecycleState
  progress: GraphProgress
}

/** 非允许转换的回执：结构化失败，不静默改状态。 */
export interface LifecycleFailure {
  code: 'invalid_transition'
  from: LifecycleState
  event: LifecycleEvent
}

export type LifecycleResult = { ok: true; lifecycle: Lifecycle } | { ok: false; failure: LifecycleFailure }

/** 声明的转换表：唯一允许完成的状态变更；未列出的 (state, event) 一律拒绝。 */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<LifecycleState, Readonly<Partial<Record<LifecycleEvent, LifecycleState>>>>
> = {
  assembled: { step: 'stepping', settle: 'settling' },
  stepping: { segment: 'stepping', suspend: 'suspended', settle: 'settling' },
  suspended: {},
  settling: { finalize: 'settled' },
  settled: {},
}

/** 初始状态（bag 校验通过、必需 owner 齐备后进入）。 */
export function initialLifecycle(progress: GraphProgress): Lifecycle {
  return { state: 'assembled', progress }
}

/** 纯转换：允许则回新生命周期（进度可选覆盖），不允许则回结构化失败。 */
export function transition(lifecycle: Lifecycle, event: LifecycleEvent, progress?: GraphProgress): LifecycleResult {
  const next = LIFECYCLE_TRANSITIONS[lifecycle.state][event]
  if (next === undefined) {
    return { ok: false, failure: { code: 'invalid_transition', from: lifecycle.state, event } }
  }
  return { ok: true, lifecycle: { state: next, progress: progress ?? lifecycle.progress } }
}

/**
 * 进程内生命周期机：状态只能经 `send` 变更；拒绝以 `failure` 暴露、返回 `ok:false`，不静默。
 * 解释器持有本机，循环结束后读取 `state` / `progress` 回填返回值。
 */
export class LifecycleMachine {
  private stage: LifecycleState
  private graphProgress: GraphProgress
  private rejected: LifecycleFailure | null = null

  constructor(progress: GraphProgress) {
    this.stage = 'assembled'
    this.graphProgress = progress
  }

  get state(): LifecycleState {
    return this.stage
  }

  get progress(): GraphProgress {
    return this.graphProgress
  }

  get failure(): LifecycleFailure | null {
    return this.rejected
  }

  send(event: LifecycleEvent, progress?: GraphProgress): LifecycleResult {
    const result = transition({ state: this.stage, progress: this.graphProgress }, event, progress)
    if (!result.ok) {
      this.rejected = result.failure
      return result
    }
    this.stage = result.lifecycle.state
    this.graphProgress = result.lifecycle.progress
    return result
  }
}

/** 段 / 回合终态标记：段边界为 `stepping`，挂起为 `pending`，回合终态取传入结局。 */
export type Ended = 'done' | 'refused' | 'pending' | 'cancelled' | 'stepping'

/** 段终态标记常量（`ended` 的段边界取值），供调用方比较而无需内嵌字面量。 */
export const SEGMENT_ENDED: Ended = 'stepping'

export function endedOf(state: LifecycleState, terminal: 'done' | 'refused' | 'cancelled'): Ended {
  if (state === 'stepping') return 'stepping'
  if (state === 'suspended') return 'pending'
  return terminal
}
