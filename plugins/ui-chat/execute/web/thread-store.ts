// 每线程视图 fold（纯函数）+ React-free store：快照 + 有序增量 + 定稿替换。
//
// 客户端真源：一个线程一份 view，渲染器只读 view，不各自持状态。
// store 只提供 getSnapshot / subscribe / commit，不 import 任何框架，壳侧可用 uSES 直接绑定。
//
// 事件语义（客户端 fold 内强制，共 8 条）：
// 1. 单连接有序：同一 SSE 连接内事件按到达顺序 fold，不重排。
// 2. run 生命周期单调：`run.started` 建立 / 替换在途回合；`model.delta` / `tool.*`
//    只作用于 run id 匹配的在途回合；`run.finished` 终结该 run。
// 3. 迟到帧丢弃：已定稿 run 的后续 delta / tool 帧一律丢弃，防止定稿后冒出幽灵回合。
// 4. 缺 started 自愈：首个 delta / tool.start 到达即建在途回合，started 丢失不丢流。
// 5. 无关终局忽略：`run.finished` 无匹配在途回合即判定为无关 run（写 run / 周期 run /
//    已收束 run），忽略而不重拉——「事件到达即全量重拉」正是要消除的。真正的增量全丢
//    场景（断线）由规则 8 的重连快照兜底。
// 6. reset 语义：`model.delta.reset === true` 清空在途回合已累积正文再追加本帧
//    （流重试重放；修掉旧实现重复追加的缺陷）。
// 7. 快照权威：快照替换权威消息段（messages / conversation / refs / kind）；
//    在途回合只由生命周期事件（定稿 / 取消 / 线程切换 / 重连）清除。
// 8. 重连：连接 false→true 时由调用方清在途回合并强制快照重同步（断线期间增量不可信）。

import { conversationList, loadConversation, threadKind } from './history-model.ts'

/** 已定稿 run 的记忆长度（丢弃迟到帧用；有界，防无界增长）。 */
export const FINISHED_MEMORY = 32

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runId(payload: any): string | null {
  return isRec(payload) && typeof payload.run === 'string' && payload.run.length > 0 ? payload.run : null
}

function threadOf(payload: any): string | null {
  return isRec(payload) && typeof payload.thread === 'string' && payload.thread.length > 0
    ? payload.thread
    : null
}

function callIdOf(payload: any): string {
  return isRec(payload) && typeof payload.call_id === 'string' ? payload.call_id : ''
}

function deltaText(payload: any): string {
  if (!isRec(payload)) return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.delta === 'string') return payload.delta
  if (typeof payload.chunk === 'string') return payload.chunk
  return ''
}

/** 空视图：线程切换 / 首屏前的占位。 */
export function emptyView(thread: string | null = null): any {
  return {
    thread,
    conversation: null,
    conversations: [],
    refs: {},
    kind: 'main',
    messages: [],
    inFlight: null,
    finishedRuns: [],
    revision: 0,
  }
}

function newInFlight(run: string | null, thread: string | null): any {
  return { run, thread, text: '', tools: [], finalizing: false, cancelled: false }
}

function rememberFinished(view: any, run: string | null): any {
  if (run === null) return view
  const finishedRuns = [run, ...view.finishedRuns.filter((item: string) => item !== run)].slice(
    0,
    FINISHED_MEMORY,
  )
  return { ...view, finishedRuns }
}

function isFinished(view: any, run: string | null): boolean {
  return run !== null && view.finishedRuns.includes(run)
}

/** 取（必要时新建）在途回合：run 不匹配时以新 run 替换。 */
function ensureInFlight(view: any, run: string | null, payload: any): any {
  if (view.inFlight !== null && (run === null || view.inFlight.run === run)) return view
  return { ...view, inFlight: newInFlight(run, threadOf(payload)) }
}

/**
 * 快照：替换权威消息段。在途回合处理：
 * - 流式中（未定稿）→ 保留（增量仍在途）；
 * - 定稿中（finalizing，run 已终局等权威消息）→ 原地替换为 null（快照即权威）。
 * 定稿替换因此不依赖任何外挂参数：定稿失败后下一次成功快照也会收口。
 */
export function applySnapshot(view: any, history: any, conversationId: unknown): any {
  const loaded = loadConversation(history, conversationId)
  return {
    ...view,
    conversation: loaded.conversation,
    conversations: conversationList(history),
    refs: isRec(history) && isRec(history.refs) ? history.refs : {},
    kind: threadKind(loaded.conversation),
    messages: loaded.messages,
    inFlight:
      view.inFlight !== null && view.inFlight.finalizing === true ? null : view.inFlight,
    revision: view.revision + 1,
  }
}

/** `run.started`：建立 / 替换在途回合；已定稿 run 忽略；自愈时缺 run id 则认领不替换。 */
export function applyRunStarted(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  if (view.inFlight !== null && view.inFlight.run === null) {
    return { ...view, inFlight: { ...view.inFlight, run } }
  }
  return ensureInFlight(view, run, payload)
}

/** `model.delta`：追加正文；缺 started 自愈；已定稿 run 丢弃；reset 清空重放。 */
export function applyDelta(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  const based = ensureInFlight(view, run, payload)
  const text = deltaText(payload)
  const nextText = payload.reset === true ? text : based.inFlight.text + text
  return { ...based, inFlight: { ...based.inFlight, text: nextText } }
}

/** `tool.start`：在途回合的工具卡（有序，按 call_id 去重后置末）。 */
export function applyToolStart(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  const based = ensureInFlight(view, run, payload)
  const callId = callIdOf(payload)
  if (callId.length === 0) return based
  const tools = based.inFlight.tools.filter((item: any) => item.callId !== callId)
  tools.push({
    callId,
    tool: typeof payload.tool === 'string' ? payload.tool : '',
    render: isRec(payload.render) ? payload.render : null,
    args: payload.args ?? null,
    chunks: '',
    done: false,
  })
  return { ...based, inFlight: { ...based.inFlight, tools } }
}

/** `tool.delta`：追加工具输出块（当前无生产者，语义先定死）。 */
export function applyToolDelta(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  if (view.inFlight === null) return view
  const callId = callIdOf(payload)
  const chunk = deltaText(payload)
  if (callId.length === 0 || chunk.length === 0) return view
  const tools = view.inFlight.tools.map((item: any) =>
    item.callId === callId ? { ...item, chunks: item.chunks + chunk } : item,
  )
  return { ...view, inFlight: { ...view.inFlight, tools } }
}

/** `tool.end`：标记工具卡终态。 */
export function applyToolEnd(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  if (view.inFlight === null) return view
  const callId = callIdOf(payload)
  if (callId.length === 0) return view
  const tools = view.inFlight.tools.map((item: any) =>
    item.callId === callId ? { ...item, done: true } : item,
  )
  return { ...view, inFlight: { ...view.inFlight, tools } }
}

/**
 * `run.finished` 处置：返回 `{view, action}`。
 * action ∈ 'finalize'（done，等快照原地替换）| 'cancel'（保留在途并标记取消）
 *        | 'ignore'（迟到 / 重复 / 无匹配在途回合的无关终局）。
 * 匹配放宽：任一侧 run id 缺失时视为匹配（自愈回合可能没认领到 run id）。
 */
export function foldRunFinished(view: any, payload: any): { view: any; action: string } {
  const run = runId(payload)
  if (isFinished(view, run)) return { view, action: 'ignore' }
  const inFlight = view.inFlight
  const matched =
    inFlight !== null && (inFlight.run === null || run === null || inFlight.run === run)
  const marked = rememberFinished(view, run)
  if (!matched) return { view: marked, action: 'ignore' }
  if (payload.status === 'cancelled') {
    return {
      view: { ...marked, inFlight: { ...marked.inFlight, cancelled: true, finalizing: false } },
      action: 'cancel',
    }
  }
  return { view: { ...marked, inFlight: { ...marked.inFlight, finalizing: true } }, action: 'finalize' }
}

/** 丢弃在途回合：快照已含定稿消息（传 run）或线程切换 / 重连（不传 run）。 */
export function dropInFlight(view: any, run: string | null = null): any {
  if (view.inFlight === null) return view
  if (run !== null && view.inFlight.run !== run) return view
  return { ...view, inFlight: null }
}

/** 是否正在流式（在途且未取消）。 */
export function isStreaming(view: any): boolean {
  return view.inFlight !== null && view.inFlight.cancelled !== true
}

/** React-free store：getSnapshot / subscribe / commit（commit 带 meta 供渲染器选增量路径）。 */
export function createThreadStore(initial: any = emptyView()): {
  getSnapshot(): any
  subscribe(listener: (snapshot: any, meta?: any) => void): () => void
  commit(next: any, meta?: any): void
} {
  let view = initial
  const listeners = new Set<(snapshot: any, meta?: any) => void>()
  return {
    getSnapshot() {
      return view
    },
    subscribe(listener: (snapshot: any, meta?: any) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit(next: any, meta: any = {}) {
      if (next === view) return
      view = next
      for (const listener of [...listeners]) listener(view, meta)
    },
  }
}
