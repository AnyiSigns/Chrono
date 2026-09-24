// 审批停靠带的浏览器侧业务状态：React-free store（快照 + 订阅 + 提交）。
// 状态是唯一真源，React 只渲染；网络 / 事件全经壳 `ctx`（command / submit / events）。
// 不 import react；数据变换复用纯模型 `model.ts`。

import type { EventRecord, Json, SlotContext } from '@chrono/ui-contract'
import {
  armConfirm,
  clearConfirm,
  confirmArmed,
  CONFIRM_TTL_MS,
  defaultExpanded,
  identityActive,
  identityBody,
  isCodeGenFallbackBody,
  isRecord,
  verdictOf,
  withBusy,
  withoutBusy,
} from './model'
import type { Rec } from './model'
import { loadMessages } from './messages'

/** 整批裁决的线程键（缺 `id` = 全部；槽写在本键下）。 */
export const BATCH_THREAD = '_main'

export interface ItemError {
  code: string
  action: string
}

export interface ApprovalSnapshot {
  table: unknown
  items: Rec[]
  refs: Rec
  loading: boolean
  error: { code: string } | null
  expanded: string[]
  busy: string[]
  itemErrors: Record<string, ItemError>
  lastBatch: string | null
  decided: string[]
  confirm: { armed: string | null; at: number }
  connected: boolean
}

export interface ApprovalStore {
  getSnapshot(): ApprovalSnapshot
  subscribe(listener: (snapshot: ApprovalSnapshot) => void): () => void
  start(): void
  dispose(): void
  load(): void
  toggleExpanded(id: string): void
  resetConfirm(): void
  armOrRun(kind: string, run: () => void): void
  submitItem(item: Rec, action: string): void
  submitAll(action: string): void
}

function asRecord(value: Json): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}

function okOf(result: Json): boolean {
  const record = asRecord(result)
  return record !== null && record.ok === true
}

function valueOf(result: Json): Json {
  const record = asRecord(result)
  return record !== null ? (record.value as Json) : null
}

function codeOf(result: Json): string {
  const record = asRecord(result)
  return record !== null && typeof record.code === 'string' ? record.code : 'unknown'
}

/** 写 `#1` 本线程键的 batch directive：`put` 整份 body + `add_gen`。
 * `expectActive` 为读回身份视图的 active：显式条件写，陈旧读由内核 `stale_active` 拒写。 */
export function slotWriteDirective(body: Json, expectActive?: string | null): Json {
  const addGen: Rec = { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} }
  if (expectActive !== undefined) addGen.expect_active = expectActive
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body } },
          { op: 'add_gen', args: addGen },
        ],
      },
    },
  }
}

/** 建一份审批停靠带 store；`ctx` 为壳 api + store 绑定 + slot 注册表。 */
export function createApprovalStore(ctx: SlotContext): ApprovalStore {
  let state: ApprovalSnapshot = {
    table: null,
    items: [],
    refs: {},
    loading: true,
    error: null,
    expanded: [],
    busy: [],
    itemErrors: {},
    lastBatch: null,
    decided: [],
    confirm: { armed: null, at: 0 },
    connected: ctx.events.connected(),
  }
  const listeners = new Set<(snapshot: ApprovalSnapshot) => void>()
  let disposed = false
  let loadSeq = 0
  let confirmTimer: ReturnType<typeof setTimeout> | null = null
  let closeEvents: (() => void) | null = null

  function commit(next: ApprovalSnapshot): void {
    if (disposed) return
    state = next
    for (const listener of [...listeners]) listener(state)
  }

  function resetConfirm(): void {
    if (confirmTimer !== null) {
      clearTimeout(confirmTimer)
      confirmTimer = null
    }
    if (state.confirm.armed === null) return
    commit({ ...state, confirm: clearConfirm() })
  }

  function armOrRun(kind: string, run: () => void): void {
    const now = Date.now()
    if (confirmArmed(state.confirm, kind, now)) {
      resetConfirm()
      run()
      return
    }
    if (confirmTimer !== null) clearTimeout(confirmTimer)
    commit({ ...state, confirm: armConfirm(state.confirm, kind, now) })
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      commit({ ...state, confirm: clearConfirm() })
    }, CONFIRM_TTL_MS)
  }

  function toggleExpanded(id: string): void {
    const expanded = state.expanded.includes(id)
      ? state.expanded.filter((item) => item !== id)
      : [...state.expanded, id]
    commit({ ...state, expanded })
  }

  async function loadTable(): Promise<void> {
    const table = await loadMessages(fetch, ctx.tokens.messages)
    if (disposed) return
    commit({ ...state, table })
  }

  async function load(): Promise<void> {
    const seq = (loadSeq += 1)
    const result = await ctx.command('approval.list', null)
    if (disposed || seq !== loadSeq) return
    const ok = okOf(result)
    const body = ok ? (asRecord(valueOf(result)) ?? {}) : {}
    let error: { code: string } | null = null
    if (!ok) {
      error = { code: codeOf(result) }
    } else if (body.ok === false) {
      const err = asRecord(body.error)
      error = { code: err !== null && typeof err.code === 'string' ? err.code : 'unknown' }
    }
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : []
    const refs = asRecord(body.refs) ?? {}
    const expanded = [...state.expanded]
    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : null
      if (id !== null && defaultExpanded(item) && !expanded.includes(id)) expanded.push(id)
    }
    commit({ ...state, loading: false, error, items, refs, expanded })
  }

  /** 裁决两步走：先读-改-写本线程槽，再调无参裁决命令。 */
  async function decide(threadKey: string, slot: Rec): Promise<{ ok: boolean; code: string }> {
    const read = await ctx.command('input.read', null, { thread: threadKey })
    const body = identityBody(valueOf(read))
    // 读到代码世代回落 body（无数据世代）→ 未就绪，拒写以免污染身份。
    if (!isRecord(body) || isCodeGenFallbackBody(body)) return { ok: false, code: 'not_loaded' }
    const slots = isRecord(body.slots) ? { ...body.slots, [threadKey]: slot } : { [threadKey]: slot }
    const written = await ctx.submit([slotWriteDirective({ ...body, slots }, identityActive(valueOf(read)))], { thread: threadKey })
    if (!okOf(written)) return { ok: false, code: codeOf(written) }
    const name = typeof slot.id === 'string' && slot.id.length > 0 ? 'approval.decide' : 'approval.decide_all'
    const result = await ctx.command(name, null, { thread: threadKey })
    const ok = okOf(result)
    return { ok, code: ok ? '' : codeOf(result) }
  }

  async function submitItem(item: Rec, action: string): Promise<void> {
    const verdict = verdictOf(action)
    const id = typeof item.id === 'string' ? item.id : ''
    if (verdict === null || id.length === 0) return
    const itemErrors = { ...state.itemErrors }
    delete itemErrors[id]
    commit({ ...state, busy: withBusy(state.busy, id), itemErrors })
    const threadKey = typeof item.thread === 'string' && item.thread.length > 0 ? item.thread : BATCH_THREAD
    const result = await decide(threadKey, { kind: 'approval.decide', id, verdict })
    if (disposed) return
    if (!result.ok) {
      // 续跑回合可能超出命令等待上限；已收到 `approval.decided` 的条目按成功处理，不显假失败。
      if (state.decided.includes(id)) {
        commit({ ...state, busy: withoutBusy(state.busy, id) })
        void load()
        return
      }
      commit({ ...state, busy: withoutBusy(state.busy, id), itemErrors: { ...state.itemErrors, [id]: { code: result.code, action } } })
      return
    }
    commit({ ...state, busy: withoutBusy(state.busy, id) })
    void load()
  }

  async function submitAll(action: string): Promise<void> {
    const verdict = verdictOf(action)
    if (verdict === null) return
    commit({ ...state, busy: withBusy(state.busy, 'all'), error: null, lastBatch: action })
    const result = await decide(BATCH_THREAD, { kind: 'approval.decide', verdict })
    if (disposed) return
    if (!result.ok) {
      if (state.decided.length > 0) {
        commit({ ...state, busy: withoutBusy(state.busy, 'all') })
        void load()
        return
      }
      commit({ ...state, busy: withoutBusy(state.busy, 'all'), error: { code: result.code } })
      return
    }
    commit({ ...state, busy: withoutBusy(state.busy, 'all') })
    void load()
  }

  function onRecord(record: EventRecord): void {
    if (record.topic === 'shell.state') {
      const payload = asRecord(record.payload) ?? {}
      const wasConnected = state.connected
      const connected = payload.connected === true
      if (connected !== wasConnected) commit({ ...state, connected })
      if (connected && !wasConnected && state.error !== null) void load()
      return
    }
    if (record.topic === 'approval.pending' || record.topic === 'approval.decided') {
      if (record.topic === 'approval.decided') {
        const payload = asRecord(record.payload) ?? {}
        const id = typeof payload.id === 'string' ? payload.id : ''
        if (id.length > 0 && !state.decided.includes(id)) {
          commit({ ...state, decided: [...state.decided, id] })
        }
      }
      void load()
    }
  }

  function start(): void {
    if (disposed || closeEvents !== null) return
    closeEvents = ctx.events.onAny(onRecord)
    void loadTable()
    void load()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (confirmTimer !== null) clearTimeout(confirmTimer)
    confirmTimer = null
    if (closeEvents !== null) closeEvents()
    closeEvents = null
    listeners.clear()
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: (snapshot: ApprovalSnapshot) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    dispose,
    load: () => {
      void load()
    },
    toggleExpanded,
    resetConfirm,
    armOrRun,
    submitItem: (item, action) => {
      void submitItem(item, action)
    },
    submitAll: (action) => {
      void submitAll(action)
    },
  }
}
