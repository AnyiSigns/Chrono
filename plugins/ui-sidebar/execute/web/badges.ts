// 会话项状态角标状态机（纯函数，可单测）：把宿主 / 会话事件归约成每线程角标态。
// 角标优先级：待审批（闸门）> 运行中 > 失败 > 未读（计数）；不常驻红点——
// 失败 / 待审批随状态变化消失，运行中随 `run.finished` 消失，未读随选中该会话清空。

export interface BadgeState {
  running: Record<string, string | null>
  runs: Record<string, string>
  pending: Record<string, number>
  failed: Record<string, boolean>
  unread: Record<string, number>
}

export interface Badge {
  kind: 'pending' | 'running' | 'failed' | 'unread'
  count?: number
  run?: string | null
}

/** 角标种类（按优先级从高到低）。 */
export const BADGE_PRIORITY = ['pending', 'running', 'failed', 'unread']

/** 初始角标态：running 记线程→run；runs 记 run→线程（供终止与收口对账）。 */
export function createBadgeState(): BadgeState {
  return { running: {}, runs: {}, pending: {}, failed: {}, unread: {} }
}

/** 事件线程键：`thread` 优先，回落 `conversation`；非字符串回 null。 */
export function threadOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as { thread?: unknown; conversation?: unknown }
  const value = record.thread ?? record.conversation
  return typeof value === 'string' && value.length > 0 ? value : null
}

function copy(state: BadgeState): BadgeState {
  return {
    running: { ...state.running },
    runs: { ...state.runs },
    pending: { ...state.pending },
    failed: { ...state.failed },
    unread: { ...state.unread },
  }
}

function approvalCount(pending: unknown): number | null {
  if (pending === null || typeof pending !== 'object') return null
  const value = (pending as { approval?: unknown }).approval
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/** 归约一条事件；未知 topic 原样返回。`impl` 保留以便将来区分来源。 */
export function applyEvent(state: BadgeState, impl: unknown, topic: unknown, payload: unknown): BadgeState {
  const thread = threadOf(payload)
  if (thread === null) return state
  const next = copy(state)
  const record: { [key: string]: any } = payload !== null && typeof payload === 'object' ? (payload as { [key: string]: any }) : {}
  switch (topic) {
    case 'run.started': {
      const run = typeof record.run === 'string' && record.run.length > 0 ? record.run : null
      next.running[thread] = run
      if (run !== null) next.runs[run] = thread
      delete next.failed[thread]
      return next
    }
    case 'run.finished': {
      const run = typeof record.run === 'string' && record.run.length > 0 ? record.run : null
      if (run === null || next.running[thread] === run) delete next.running[thread]
      if (run !== null && next.runs[run] === thread) delete next.runs[run]
      if (record.status === 'failed') next.failed[thread] = true
      return next
    }
    case 'thread.updated': {
      if (record.status === 'failed') next.failed[thread] = true
      else if (typeof record.status === 'string') delete next.failed[thread]
      const approval = approvalCount(record.pending)
      if (approval === null) {
        // 未携带 pending：不动待审批态
      } else if (approval > 0) {
        next.pending[thread] = approval
      } else {
        delete next.pending[thread]
      }
      if (record.inbox !== null && typeof record.inbox === 'object') {
        const count = typeof record.inbox.count === 'number' ? record.inbox.count : 0
        const lastSeen = typeof record.inbox.last_seen === 'number' ? record.inbox.last_seen : 0
        if (count > lastSeen) next.unread[thread] = count - lastSeen
        else delete next.unread[thread]
      }
      return next
    }
    case 'approval.pending': {
      const count = typeof record.count === 'number' && record.count > 0 ? record.count : 1
      next.pending[thread] = count
      return next
    }
    case 'approval.decided': {
      if (record.count === 0) delete next.pending[thread]
      return next
    }
    case 'group.message': {
      next.unread[thread] = (next.unread[thread] ?? 0) + 1
      return next
    }
    case 'thread.closed': {
      delete next.running[thread]
      delete next.pending[thread]
      delete next.failed[thread]
      return next
    }
    default:
      return state
  }
}

/** 当前角标（按优先级）：待审批 > 运行中 > 失败 > 未读；无则 null。 */
export function badgeFor(state: BadgeState, conversationId: unknown): Badge | null {
  const id = typeof conversationId === 'string' ? conversationId : ''
  if (id.length === 0) return null
  const pending = state.pending[id]
  if (typeof pending === 'number' && pending > 0) return { kind: 'pending', count: pending }
  if (Object.prototype.hasOwnProperty.call(state.running, id)) {
    return { kind: 'running', run: state.running[id] ?? null }
  }
  if (state.failed[id] === true) return { kind: 'failed' }
  const unread = state.unread[id]
  if (typeof unread === 'number' && unread > 0) return { kind: 'unread', count: unread }
  return null
}

/** 运行中角标对应的 run id（无则 null）——终止按钮据此 `api.cancel(run)`。 */
export function runningRun(state: BadgeState, conversationId: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(state.running, conversationId)) return null
  const run = state.running[conversationId]
  return typeof run === 'string' && run.length > 0 ? run : null
}

/**
 * 组聚合角标（窄栏轨道用）：取组内最高优先级角标；未读优先级最低、计数跨会话求和。
 * 空组或全组无角标时返回 null。
 */
export function badgeForGroup(state: BadgeState, conversationIds: readonly string[]): Badge | null {
  let top: Badge | null = null
  let unread = 0
  for (const id of conversationIds) {
    const badge = badgeFor(state, id)
    if (badge === null) continue
    if (badge.kind === 'unread') {
      unread += badge.count ?? 0
      continue
    }
    if (top === null || BADGE_PRIORITY.indexOf(badge.kind) < BADGE_PRIORITY.indexOf(top.kind)) top = badge
  }
  if (top !== null) return top
  return unread > 0 ? { kind: 'unread', count: unread } : null
}

/** 清某会话未读（选中即已读）。 */
export function clearUnread(state: BadgeState, conversationId: string): BadgeState {
  if (!Object.prototype.hasOwnProperty.call(state.unread, conversationId)) return state
  const next = copy(state)
  delete next.unread[conversationId]
  return next
}

/**
 * 用 `chat.history` 会话列表补种角标（首屏无事件时的初值）：
 * `status:"failed"` → 失败；`pending.approval` → 待审批；`inbox.count - last_seen` → 未读；
 * `status:"running"` → 运行中（run id 未知，终止按钮待 `run.started` 补齐）。
 * 已由事件给出的字段优先，不被历史覆盖。
 */
export function seedFromHistory(state: BadgeState, conversations: any[]): BadgeState {
  const next = copy(state)
  for (const conversation of conversations) {
    const id = conversation.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (conversation.status === 'failed') next.failed[id] = true
    if (conversation.status === 'running' && !Object.prototype.hasOwnProperty.call(next.running, id)) {
      next.running[id] = null
    }
    const approval = approvalCount(conversation.pending)
    if (approval !== null && approval > 0 && next.pending[id] === undefined) next.pending[id] = approval
    if (conversation.inbox !== null && conversation.inbox !== undefined) {
      const count = typeof conversation.inbox.count === 'number' ? conversation.inbox.count : 0
      const lastSeen = typeof conversation.inbox.last_seen === 'number' ? conversation.inbox.last_seen : 0
      if (count > lastSeen && next.unread[id] === undefined) next.unread[id] = count - lastSeen
    }
  }
  return next
}
