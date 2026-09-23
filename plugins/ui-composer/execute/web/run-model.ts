// 回合 run 追踪（纯状态迁移，不触 DOM / 网络）。
// 宿主对**所有** command / submit 都广播 `run.started` / `run.finished`，故输入卡不能把任意
// run 都当作自己的回合：本模型只认「本插件派发 `chat.send` 后等到的那个 run」为回合 run；
// 槽写 run 只用于确认读-改-写已落账（落账后 `chat.send` 才读得到新槽）。
// 状态字段：
//   runs        threadKey -> 当前回合 run id（生成中）
//   writing     threadKey -> true：本线程槽写请求在途
//   expecting   threadKey -> true：已触发 `chat.send`、等它的 run.started
//   pendingWrite threadKey -> 槽写 run id：等它落账后触发 `chat.send`
//   finishedRuns run id -> true：已结束但尚未被认领的 run（吸收「落账事件先于 pendingWrite」竞态）

export interface RunState {
  runs: { [threadKey: string]: string }
  writing: { [threadKey: string]: boolean }
  expecting: { [threadKey: string]: boolean }
  pendingWrite: { [threadKey: string]: string }
  finishedRuns: { [run: string]: boolean }
}

/** 初始追踪状态。 */
export function createRunState(): RunState {
  return { runs: {}, writing: {}, expecting: {}, pendingWrite: {}, finishedRuns: {} }
}

/** 线程是否忙（生成中 / 槽写在途 / 待 run.started / 等写落账）。 */
export function isThreadBusy(state: RunState, threadKey: string): boolean {
  return (
    typeof state.runs[threadKey] === 'string' ||
    state.writing[threadKey] === true ||
    state.expecting[threadKey] === true ||
    typeof state.pendingWrite[threadKey] === 'string'
  )
}

export function beginWrite(state: RunState, threadKey: string): RunState {
  return { ...state, writing: { ...state.writing, [threadKey]: true } }
}

export function endWrite(state: RunState, threadKey: string): RunState {
  if (state.writing[threadKey] !== true) return state
  const writing = { ...state.writing }
  delete writing[threadKey]
  return { ...state, writing }
}

/** 标记等待某个槽写 run 落账；若该 run 已结束则立即解除并让调用方派发。 */
export function armWrite(
  state: RunState,
  threadKey: string,
  run: string,
): { state: RunState; dispatch: boolean } {
  const pendingWrite = { ...state.pendingWrite, [threadKey]: run }
  if (state.finishedRuns[run] === true) {
    return { state: releaseWrite({ ...state, pendingWrite }, threadKey, run), dispatch: true }
  }
  return { state: { ...state, pendingWrite }, dispatch: false }
}

/** 槽写 run 落账：解除等待并清掉它的结束记录。 */
export function releaseWrite(state: RunState, threadKey: string, run: string): RunState {
  if (state.pendingWrite[threadKey] !== run) return state
  const pendingWrite = { ...state.pendingWrite }
  delete pendingWrite[threadKey]
  const finishedRuns = { ...state.finishedRuns }
  delete finishedRuns[run]
  return { ...state, pendingWrite, finishedRuns }
}

/** 已触发 `chat.send`，等它的 run.started。 */
export function expectTurn(state: RunState, threadKey: string): RunState {
  return { ...state, expecting: { ...state.expecting, [threadKey]: true } }
}

export function clearExpecting(state: RunState, threadKey: string): RunState {
  if (state.expecting[threadKey] !== true) return state
  const expecting = { ...state.expecting }
  delete expecting[threadKey]
  return { ...state, expecting }
}

/** `run.started`：仅当本线程在等回合 run 时认领；其余 run 不构成「生成中」。 */
export function trackRunStarted(
  state: RunState,
  run: unknown,
  threadKey: string,
): { state: RunState; turnStarted: boolean } {
  if (typeof run !== 'string' || state.expecting[threadKey] !== true) {
    return { state, turnStarted: false }
  }
  const expecting = { ...state.expecting }
  delete expecting[threadKey]
  return {
    state: { ...state, runs: { ...state.runs, [threadKey]: run }, expecting },
    turnStarted: true,
  }
}

export interface FinishedFold {
  state: RunState
  kind: 'write' | 'turn' | 'other'
}

/**
 * `run.finished`：三态——
 * `write` = 槽写 run 落账（调用方随后派发 `chat.send`）；`turn` = 本插件回合结束；
 * `other` = 宿主的其它 run（只登记结束 id，供竞态认领）。
 */
export function trackRunFinished(state: RunState, run: unknown, threadKey: string): FinishedFold {
  if (typeof run !== 'string') return { state, kind: 'other' }
  if (state.pendingWrite[threadKey] === run) {
    return { state: releaseWrite(state, threadKey, run), kind: 'write' }
  }
  if (state.runs[threadKey] === run) {
    const runs = { ...state.runs }
    delete runs[threadKey]
    return { state: { ...state, runs }, kind: 'turn' }
  }
  return { state: rememberFinished(state, run), kind: 'other' }
}

/** 结束记录有界（只吸收近期的落账竞态，不无限增长）。 */
function rememberFinished(state: RunState, run: string): RunState {
  const finishedRuns = { ...state.finishedRuns, [run]: true }
  const keys = Object.keys(finishedRuns)
  if (keys.length <= 64) return { ...state, finishedRuns }
  const trimmed: { [run: string]: boolean } = {}
  for (const key of keys.slice(keys.length - 32)) trimmed[key] = true
  return { ...state, finishedRuns: trimmed }
}
