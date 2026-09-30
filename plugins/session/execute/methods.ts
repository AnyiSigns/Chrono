// 能力类 `session` 的方法：会话运行记录（消息链 + 会话元数据）写**自有持久存储**（④），
// 不再构造世界写计划、不读投影。写即时落盘（边跑边追加），每条消息盖回合 id 供幂等收敛。
// 服务仍不读投影、不自取时钟（`now` 取调用帧 `env.now`）；槽清理由 input 服务承担。

import { SessionStore } from './store.ts'
import type { Rec } from './store.ts'
import {
  asArray,
  conversationEvent,
  conversationsOf,
  isoAt,
  messageBody,
  optionalMessageFields,
  summaryOf,
  threadKeyOf,
} from './plan.ts'
import { BadArgsError, asString, isRecord, nowOf } from 'plugin-sdk'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller } from 'plugin-sdk'
import { refused, validateOutcome, validateStepRecord } from './contract/index.ts'
import type { TurnOutcome } from './contract/index.ts'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'terminated'])

/** 记不下来就停：步记录 / 回合头写不进时的 fail-closed 结局。 */
function ownerUnavailable(message: string): TurnOutcome {
  return refused({ code: 'owner_unavailable', attributableTo: 'owner', retryable: true, message })
}

const STEP_APPEND_TYPES = new Set(['step.intent', 'step.result', 'checkpoint'])

/** 服务依赖：反向调用通道（清输入槽）+ 会话存储。 */
export interface SessionDeps {
  port: PortCaller
  store: SessionStore
}

function requireRecord(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  return value
}

function slotKind(slot: Json | undefined): string | null {
  return isRecord(slot) ? asString(slot['kind']) : null
}

function numberField(record: Rec | null, key: string): number | null {
  if (record === null) return null
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function inboxOf(conversation: Rec): Rec {
  return isRecord(conversation['inbox']) ? (conversation['inbox'] as Rec) : {}
}

/** 本线程槽体：args.slot 优先，否则取 args.slots.slots[threadId]。 */
function slotOf(args: Rec, threadId: string): Json | undefined {
  if (args['slot'] !== undefined) return args['slot']
  const slots = args['slots']
  if (!isRecord(slots)) return undefined
  const body = slots['slots']
  if (!isRecord(body)) return undefined
  return body[threadId]
}

/** 消息 id：同回合同角色恒定（续跑 / 重试幂等收敛）；无回合时按序数生成。 */
function messageId(conv: string, run: string | null, ordinal: number, role: string): string {
  return run !== null ? `msg-${conv}-${run}-${role}` : `msg-${conv}-${ordinal}-${role}`
}

/** 只清槽的失败计划（无业务写）：把本线程槽置 idle 交 input 服务。 */
async function clearSlot(deps: SessionDeps, threadId: string): Promise<void> {
  await deps.port.call('input', 'clear', { thread_id: threadId })
}

function fail(deps: SessionDeps, threadId: string, payload: Json): HandlerResult {
  void clearSlot(deps, threadId)
  return { value: payload, events: [] }
}

/** 槽驱动的通用入口：解析线程键、槽体与槽 kind。 */
function slotContext(args: Rec): { threadId: string; slot: Json | undefined } {
  return { threadId: threadKeyOf(args), slot: slotOf(args, threadKeyOf(args)) }
}

function newConversationEntry(
  id: string,
  workspaceId: string | null,
  title: string,
  at: string,
  kind: string,
  parent: Rec | null = null,
  agent: Rec | null = null,
): Rec {
  return {
    id,
    workspace_id: workspaceId,
    title,
    kind,
    parent,
    agent,
    participants: [],
    inbox: { tail: null, count: 0, last_seen: 0 },
    status: 'waiting',
    last_activity: null,
    pending: { approval: 0, question: 0 },
    created: at,
    deleted_at: null,
  }
}

/** 软删后的 current 回退：同工作区最近一条未删会话（无则 null）。 */
function fallbackCurrent(store: SessionStore, removed: Rec, removedId: string): string | null {
  const list = store.body()['conversations'] as Json[]
  const workspace = removed['workspace_id'] ?? null
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (!isRecord(item) || item['id'] === removedId) continue
    if ((item['workspace_id'] ?? null) !== workspace) continue
    if (item['deleted_at'] !== null && item['deleted_at'] !== undefined) continue
    return asString(item['id'])
  }
  return null
}

// ── commit ────────────────────────────────────────────────────────────────

const DEFAULT_TITLE = '新对话'

async function commit(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const now = nowOf(env)
  const at = isoAt(now)
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'chat.message') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const store = deps.store
  const requested = asString(args['conversation']) ?? store.currentId()
  let conversationId = requested
  let conversation = conversationId === null ? null : store.conversation(conversationId)
  let created = false
  if (conversation === null || conversationId === null) {
    const spec = isRecord(args['new_conversation']) ? (args['new_conversation'] as Rec) : null
    const id = spec === null ? null : asString(spec['id'])
    const workspaceId = spec === null ? null : asString(spec['workspace_id'])
    if (spec === null || id === null || workspaceId === null) {
      return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
    }
    conversation = newConversationEntry(id, workspaceId, asString(spec['title']) ?? DEFAULT_TITLE, at, 'main')
    conversationId = id
    created = true
  }
  const append = args['append'] === true
  const error = asString(args['error'])
  const result = error !== null
    ? commitError({ args, env, at, deps, threadId, conversationId, conversation, slot, error, created, append })
    : commitNormal({ args, env, at, deps, threadId, conversationId, conversation, slot, created, append })
  await clearSlot(deps, threadId)
  return result
}

interface CommitInput {
  args: Rec
  env: CallEnv
  at: string
  deps: SessionDeps
  threadId: string
  conversationId: string
  conversation: Rec
  slot?: Json
  created: boolean
  append: boolean
}

function commitNormal(ctx: CommitInput): HandlerResult {
  const { args, env, at, deps, threadId, conversationId, conversation, slot, created, append } = ctx
  const store = deps.store
  const run = env.run
  const count = store.messagesOf(conversationId).length
  const last = store.messagesOf(conversationId)[count - 1] ?? null
  const prevId = last !== null ? asString(last['id']) : null
  const userSource = isRecord(args['user']) ? (args['user'] as Rec) : null
  const assistant = requireRecord(args['assistant'], 'assistant')
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const assistantContent = asString(assistant['content']) ?? ''

  store.turnOpen(run, conversationId)
  let userBody: Rec | null = null
  if (!append) {
    const userContent = asString(userSource?.['content']) ?? asString(slotRec?.['text']) ?? ''
    const userExtra = optionalMessageFields(userSource)
    if (userExtra['attachments'] === undefined && Array.isArray(slotRec?.['attachments'])) {
      userExtra['attachments'] = slotRec['attachments']
    }
    userBody = messageBody(
      'user',
      messageId(conversationId, run, count, 'user'),
      userContent,
      prevId === null ? null : { def: prevId },
      at,
      userExtra,
    )
    store.appendMessage(run, conversationId, userBody)
  }
  const assistantBody = messageBody(
    'assistant',
    messageId(conversationId, run, count + (append ? 0 : 1), 'assistant'),
    assistantContent,
    append
      ? prevId === null ? null : { def: prevId }
      : { def: userBody === null ? prevId : (userBody['id'] as string) },
    at,
    optionalMessageFields(assistant),
  )
  store.appendMessage(run, conversationId, assistantBody)

  const inbox = inboxOf(conversation)
  const inboxCount = numberField(inbox, 'count') ?? 0
  const lastSeenArg = numberField(args, 'last_seen')
  const status = asString(args['status']) ?? asString(conversation['status'])
  const nextConversation: Rec = {
    ...conversation,
    last_activity: { at, summary: summaryOf(assistantContent) },
  }
  if (status !== null) nextConversation['status'] = status
  if (isRecord(conversation['inbox'])) {
    nextConversation['inbox'] = {
      ...inbox,
      last_seen: Math.max(numberField(inbox, 'last_seen') ?? 0, lastSeenArg ?? inboxCount),
    }
  }
  store.upsertConversation(run, nextConversation)
  if (created) store.setCurrent(run, conversationId)
  store.turnClose(run)

  const finalCount = store.messagesOf(conversationId).length
  const events = []
  const kind = asString(conversation['kind']) ?? 'main'
  if (created) {
    events.push({ topic: 'thread.opened', payload: { ...conversationEvent(env, conversationId), kind } })
  }
  if (kind === 'group' && userBody !== null) {
    events.push({
      topic: 'group.message',
      payload: { ...conversationEvent(env, conversationId), id: userBody['id'], seq: count, from: 'user' },
    })
  }
  events.push({
    topic: 'thread.updated',
    payload: {
      ...conversationEvent(env, conversationId),
      changed: created ? ['current', 'head', 'count', 'last_activity'] : ['head', 'count', 'last_activity'],
    },
  })
  void threadId
  return {
    value: { ok: true, reply: assistantBody, conversation: conversationId, count: finalCount },
    events,
  }
}

function commitError(ctx: CommitInput & { error: string }): HandlerResult {
  const { args, env, at, deps, conversationId, conversation, slot, error, created, append } = ctx
  const store = deps.store
  const run = env.run
  const count = store.messagesOf(conversationId).length
  const last = store.messagesOf(conversationId)[count - 1] ?? null
  const prevId = last !== null ? asString(last['id']) : null
  store.turnOpen(run, conversationId)
  if (!append) {
    const userSource = isRecord(args['user']) ? (args['user'] as Rec) : null
    const slotRec = isRecord(slot) ? (slot as Rec) : null
    const userContent = asString(userSource?.['content']) ?? asString(slotRec?.['text']) ?? ''
    const userExtra = optionalMessageFields(userSource)
    if (userExtra['attachments'] === undefined && Array.isArray(slotRec?.['attachments'])) {
      userExtra['attachments'] = slotRec['attachments']
    }
    const userBody = messageBody(
      'user',
      messageId(conversationId, run, count, 'user'),
      userContent,
      prevId === null ? null : { def: prevId },
      at,
      userExtra,
    )
    store.appendMessage(run, conversationId, userBody)
  }
  const lastAfterUser = store.messagesOf(conversationId)
  const systemPrev = lastAfterUser.length > 0 ? asString(lastAfterUser[lastAfterUser.length - 1]['id']) : null
  const systemBody = messageBody(
    'system',
    messageId(conversationId, run, count + (append ? 0 : 1), 'system'),
    error,
    systemPrev === null ? null : { def: systemPrev },
    at,
    { meta: { error } },
  )
  store.appendMessage(run, conversationId, systemBody)
  const nextConversation: Rec = {
    ...conversation,
    last_activity: { at, summary: summaryOf(error) },
  }
  store.upsertConversation(run, nextConversation)
  if (created) store.setCurrent(run, conversationId)
  store.turnClose(run)
  const events = []
  if (created) {
    events.push({
      topic: 'thread.opened',
      payload: { ...conversationEvent(env, conversationId), kind: asString(conversation['kind']) ?? 'main' },
    })
  }
  events.push({
    topic: 'thread.updated',
    payload: {
      ...conversationEvent(env, conversationId),
      changed: created ? ['current', 'head', 'count', 'last_activity'] : ['head', 'count', 'last_activity'],
    },
  })
  return { value: { ok: false, error, conversation: conversationId }, events }
}

// ── new_conversation / select / rename / set_title ─────────────────────────

async function newConversation(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const now = nowOf(env)
  const at = isoAt(now)
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.new') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const workspaceId = asString(args['workspace_id']) ?? asString(slotRec?.['workspace_id'])
  const title = asString(args['title']) ?? DEFAULT_TITLE
  const id = asString(args['conversation_id']) ?? `c-${now}-${conversationsOf(store.body()).length}`
  const entry = newConversationEntry(id, workspaceId, title, at, 'main')
  store.upsertConversation(env.run, entry)
  store.setCurrent(env.run, id)
  await clearSlot(deps, threadId)
  const events = [
    { topic: 'thread.opened', payload: { ...conversationEvent(env, id), kind: 'main' } },
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['current'] } },
  ]
  return { value: { ok: true, conversation: id }, events }
}

async function select(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.select') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? store.currentId()
  if (id === null) return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = store.conversation(id)
  if (conversation === null) return fail(deps, threadId, { ok: false, reason: 'not_found' })
  if (conversation['deleted_at'] !== null && conversation['deleted_at'] !== undefined) {
    return fail(deps, threadId, { ok: false, reason: 'deleted' })
  }
  store.setCurrent(env.run, id)
  await clearSlot(deps, threadId)
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['current'] } },
  ]
  return { value: { ok: true, conversation: id }, events }
}

async function rename(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.rename') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? store.currentId()
  const title = asString(args['title']) ?? asString(slotRec?.['title'])
  if (id === null) return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
  if (title === null) return fail(deps, threadId, { ok: false, reason: 'missing_title' })
  const conversation = store.conversation(id)
  if (conversation === null) return fail(deps, threadId, { ok: false, reason: 'not_found' })
  store.upsertConversation(env.run, { ...conversation, title })
  await clearSlot(deps, threadId)
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['title'] } },
  ]
  return { value: { ok: true, conversation: id, title }, events }
}

/** 服务调用路径：args 驱动、不经输入槽、不清槽。 */
function setTitle(args: Rec, env: CallEnv, deps: SessionDeps): HandlerResult {
  const id = asString(args['conversation'])
  const title = asString(args['title'])
  if (id === null) throw new BadArgsError('conversation required')
  if (title === null) throw new BadArgsError('title required')
  const store = deps.store
  const conversation = store.conversation(id)
  if (conversation === null) {
    return { value: { ok: false, reason: 'not_found', conversation: id }, events: [] }
  }
  store.upsertConversation(env.run, { ...conversation, title })
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['title'] } },
  ]
  return { value: { ok: true, conversation: id, title }, events }
}

// ── delete / restore / branch ──────────────────────────────────────────────

async function deleteConversation(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const now = nowOf(env)
  const at = isoAt(now)
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.delete') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? store.currentId()
  if (id === null) return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = store.conversation(id)
  if (conversation === null) return fail(deps, threadId, { ok: false, reason: 'not_found' })
  const currentChanged = store.currentId() === id
  store.softDelete(env.run, id, at)
  const nextCurrent = currentChanged ? fallbackCurrent(store, conversation, id) : store.currentId()
  if (currentChanged) store.setCurrent(env.run, nextCurrent)
  await clearSlot(deps, threadId)
  const events = [
    {
      topic: 'thread.closed',
      payload: { ...conversationEvent(env, id), status: asString(conversation['status']) },
    },
  ]
  if (currentChanged) {
    events.push({
      topic: 'thread.updated',
      payload: { ...conversationEvent(env, nextCurrent), changed: ['current'] },
    })
  }
  return { value: { ok: true, conversation: id, current: nextCurrent }, events }
}

async function restore(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.restore') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? store.currentId()
  if (id === null) return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = store.conversation(id)
  if (conversation === null) return fail(deps, threadId, { ok: false, reason: 'not_found' })
  store.restore(env.run, id)
  await clearSlot(deps, threadId)
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['deleted_at'] } },
  ]
  return { value: { ok: true, conversation: id }, events }
}

/** 分支：把源会话链截至目标消息的窗口拷进新会话（新 id、prev 重建）。 */
async function branch(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const now = nowOf(env)
  const at = isoAt(now)
  const { threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.branch') {
    return fail(deps, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const store = deps.store
  const sourceId = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? store.currentId()
  const messageRef = asString(args['message']) ?? asString(slotRec?.['message'])
  if (sourceId === null) return fail(deps, threadId, { ok: false, reason: 'no_conversation' })
  if (messageRef === null) return fail(deps, threadId, { ok: false, reason: 'missing_message' })
  const source = store.conversation(sourceId)
  if (source === null) return fail(deps, threadId, { ok: false, reason: 'not_found' })
  const sourceMessages = store.messagesOf(sourceId)
  const targetIndex = sourceMessages.findIndex(
    (msg) => msg['id'] === messageRef,
  )
  if (targetIndex < 0) return fail(deps, threadId, { ok: false, reason: 'message_not_found' })
  const window = sourceMessages.slice(0, targetIndex + 1)
  const newId = asString(args['conversation_id']) ?? `c-${now}-${conversationsOf(store.body()).length}`
  store.turnOpen(env.run, newId)
  window.forEach((msg, index) => {
    const prev = index === 0 ? null : { def: `msg-${newId}-${index - 1}-branch` }
    store.appendMessage(env.run, newId, { ...msg, id: `msg-${newId}-${index}-branch`, prev })
  })
  const entry: Rec = {
    id: newId,
    workspace_id: source['workspace_id'] ?? null,
    title: `${asString(source['title']) ?? '新对话'}（分支）`,
    kind: asString(source['kind']) ?? 'main',
    parent: { def: sourceId },
    source_message: messageRef,
    agent: source['agent'] ?? null,
    participants: asArray(source['participants']) ?? [],
    inbox: { tail: null, count: 0, last_seen: 0 },
    status: 'waiting',
    last_activity: null,
    pending: { approval: 0, question: 0 },
    created: at,
    deleted_at: null,
  }
  store.upsertConversation(env.run, entry)
  store.setCurrent(env.run, newId)
  store.turnClose(env.run)
  await clearSlot(deps, threadId)
  const events = [
    {
      topic: 'thread.opened',
      payload: { ...conversationEvent(env, newId), kind: entry['kind'], source: sourceId, message: messageRef },
    },
    { topic: 'thread.updated', payload: { ...conversationEvent(env, newId), changed: ['current'] } },
  ]
  return { value: { ok: true, conversation: newId, count: window.length }, events }
}

// ── deliver（跨线程投递） ───────────────────────────────────────────────────

async function deliver(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  const now = nowOf(env)
  const at = isoAt(now)
  const to = asString(args['to'])
  const kind = asString(args['kind'])
  if (to === null) throw new BadArgsError('to required')
  if (kind === null) throw new BadArgsError('kind required')
  if (!Object.hasOwn(args, 'body')) throw new BadArgsError('body required')
  const messageBodyValue: Json = args['body'] ?? null
  const store = deps.store

  const existing = store.conversation(to)
  const isNew = existing === null
  const conversation: Rec =
    existing ??
    {
      id: to,
      workspace_id: asString(args['workspace_id']),
      title: asString(args['title']) ?? '新对话',
      kind: asString(args['thread_kind']) ?? 'subagent',
      parent: isRecord(args['parent']) ? args['parent'] : null,
      agent: isRecord(args['agent']) ? args['agent'] : null,
      participants: asArray(args['participants']) ?? [],
      inbox: { tail: null, count: 0, last_seen: 0 },
      status: asString(args['status']) ?? 'waiting',
      last_activity: null,
      pending: isRecord(args['pending']) ? args['pending'] : { approval: 0, question: 0 },
      created: at,
      deleted_at: null,
    }

  const inbox = inboxOf(conversation)
  const inboxCount = numberField(inbox, 'count') ?? 0
  const seq = inboxCount + 1
  const tail = inbox['tail']
  const prevTail = isRecord(tail) && typeof tail['def'] === 'string' ? tail['def'] : null
  const inboxMessage: Rec = {
    id: `inbox-${to}-${seq}`,
    from: asString(args['from']) ?? 'user',
    to,
    kind,
    body: messageBodyValue,
    seq,
    at,
    prev: prevTail === null ? null : { def: prevTail },
  }
  store.appendMessage(env.run, `${to}#inbox`, inboxMessage)

  const previousStatus = asString(conversation['status'])
  const status = asString(args['status']) ?? previousStatus
  const pending = isRecord(args['pending'])
    ? args['pending']
    : (isRecord(conversation['pending']) ? conversation['pending'] : { approval: 0, question: 0 })
  const lastActivity = isRecord(args['last_activity']) ? args['last_activity'] : { at, summary: summaryOf(messageBodyValue) }
  const lastSeenArg = numberField(args, 'last_seen')
  const lastSeen = Math.max(numberField(inbox, 'last_seen') ?? 0, lastSeenArg ?? (numberField(inbox, 'last_seen') ?? 0))

  const nextConversation: Rec = {
    ...conversation,
    inbox: { tail: { def: inboxMessage['id'] }, count: seq, last_seen: lastSeen },
    status,
    last_activity: lastActivity,
    pending,
  }
  store.upsertConversation(env.run, nextConversation)

  const events = []
  const conversationKind = asString(conversation['kind']) ?? 'main'
  if (isNew) {
    events.push({ topic: 'thread.opened', payload: { ...conversationEvent(env, to), kind: conversationKind } })
  }
  const changed = ['inbox']
  if (status !== previousStatus) changed.push('status')
  events.push({ topic: 'thread.updated', payload: { ...conversationEvent(env, to), changed } })
  if (conversationKind === 'group') {
    events.push({
      topic: 'group.message',
      payload: { ...conversationEvent(env, to), id: inboxMessage['id'], seq, from: inboxMessage['from'] },
    })
  }
  if (status !== null && TERMINAL_STATUSES.has(status) && status !== previousStatus) {
    events.push({ topic: 'thread.closed', payload: { ...conversationEvent(env, to), status } })
  }
  return { value: { ok: true, to, seq, status, kind }, events }
}

// ── inbox ack（跨线程投递已读水位） ──────────────────────────────────────────

/**
 * 推进收件箱已读水位：`last_seen = max(current, seq)`，只增不减。服务调用路径（args 驱动、不清槽）。
 * 已读 / 会话未知为幂等 no-op（分别回 `advanced:false` / `not_found`）；追加失败回 `owner_unavailable`
 * （不落内存、不推进水位，未读保留供下轮重投）。
 */
async function ackInbox(args: Rec, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const conversation = asString(args['conversation'])
  const seq = numberField(args, 'seq')
  if (conversation === null) throw new BadArgsError('conversation required')
  if (seq === null) throw new BadArgsError('seq required')
  const status = await deps.store.ackInbox(env.run, conversation, seq)
  if (status === 'not_found') {
    return { value: { ok: false, reason: 'not_found', conversation }, events: [] }
  }
  if (status === 'failed') {
    return { value: { ok: false, reason: 'owner_unavailable', conversation }, events: [] }
  }
  const entry = deps.store.conversation(conversation)
  const inbox = entry !== null && isRecord(entry['inbox']) ? (entry['inbox'] as Rec) : {}
  const lastSeen = numberField(inbox, 'last_seen') ?? 0
  const events = status === 'applied'
    ? [{ topic: 'thread.updated', payload: { ...conversationEvent(env, conversation), changed: ['inbox'] } }]
    : []
  return { value: { ok: true, conversation, last_seen: lastSeen, advanced: status === 'applied' }, events }
}

// ── 回合事件日志：turn_open / step_append / turn_settle ─────────────────────

/**
 * 回合开始留痕：调模型之前写，携带用户消息与槽引用。三种结果：
 * `created` 新开（清槽）；`already_open` 同一 `turn_id` / `slot_ref` 已有回合（`state` 分在途与已收口，
 * 已收口带出结局），调用方不得再执行、不得清槽；`turn_busy` 本会话已有另一个开态回合，槽必须保留。
 * 建会话随之前移：`new_conversation` 与回合头同一次 append 落盘，无「回合已开始但会话不存在」的中间态。
 * 写不进则回合不开始：不落内存、不清槽，回 `owner_unavailable` 供重试。
 */
async function turnOpen(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  const slotRef = asString(args['slot_ref'])
  const userMessage = isRecord(args['user_message']) ? (args['user_message'] as Rec) : null
  if (turnId === null || slotRef === null || userMessage === null) {
    return { value: { ok: false, reason: 'bad_args' }, events: [] }
  }
  const at = isoAt(nowOf(env))
  const store = deps.store
  const spec = isRecord(args['new_conversation']) ? (args['new_conversation'] as Rec) : null
  const conversationId = (spec !== null ? asString(spec['id']) : null) ?? store.currentId()
  if (conversationId === null) return { value: { ok: false, reason: 'no_conversation' }, events: [] }

  let createdConversation: Rec | null = null
  // 严格按 id 判存在：`conversation()` 在显式 id 未命中时会回落到 `current`，
  // 会把「子代理旁路会话尚不存在」误判成已存在（当前仍是主会话）。
  const conversationExists = (store.body()['conversations'] as Json[]).some(
    (item) => isRecord(item) && item['id'] === conversationId,
  )
  if (!conversationExists) {
    if (spec === null) return { value: { ok: false, reason: 'no_conversation' }, events: [] }
    createdConversation = newConversationEntry(
      conversationId,
      asString(spec['workspace_id']),
      asString(spec['title']) ?? DEFAULT_TITLE,
      at,
      asString(spec['kind']) ?? 'main',
      isRecord(spec['parent']) ? (spec['parent'] as Rec) : null,
      isRecord(spec['agent']) ? (spec['agent'] as Rec) : null,
    )
  }

  const record: Rec = {
    type: 'turn.open',
    turn_id: turnId,
    conv: conversationId,
    user_message: userMessage,
    slot_ref: slotRef,
    at,
  }
  // 线程口径与子代理任务随回合头持久化：续跑据此恢复隔离上下文（子代理拿任务 + 父检查点，不继承父历史）。
  const threadKind = asString(args['thread_kind'])
  if (threadKind !== null) record['thread_kind'] = threadKind
  const taskPrompt = asString(args['task_prompt'])
  if (taskPrompt !== null) record['task_prompt'] = taskPrompt
  if (isRecord(args['parent_checkpoint']) || typeof args['parent_checkpoint'] === 'string') {
    record['parent_checkpoint'] = args['parent_checkpoint'] as Json
  }
  if (Array.isArray(args['parent_summaries'])) record['parent_summaries'] = args['parent_summaries'] as Json
  if (createdConversation !== null) record['new_conversation'] = createdConversation
  const checked = validateStepRecord(record)
  if (!checked.ok) {
    return { value: { ok: false, reason: 'invalid_contract', outcome: checked.outcome }, events: [] }
  }

  const opened = await store.openTurn(record)
  if (opened.status === 'failed') {
    return {
      value: { ok: false, reason: 'owner_unavailable', outcome: ownerUnavailable('turn log append failed') },
      events: [],
    }
  }
  const events = []
  if (opened.status === 'created' && createdConversation !== null) {
    const kind = asString(createdConversation['kind']) ?? 'main'
    events.push({ topic: 'thread.opened', payload: { ...conversationEvent(env, conversationId), kind } })
    events.push({
      topic: 'thread.updated',
      payload: {
        ...conversationEvent(env, conversationId),
        // 子代理旁路会话不抢占 current，故不声称 current 变更。
        changed: kind === 'subagent' ? ['head', 'count'] : ['current', 'head', 'count'],
      },
    })
  }
  const threadId = asString(args['thread_id']) ?? asString(env.thread)
  if (opened.status === 'created' && threadId !== null) await clearSlot(deps, threadId)
  const value: Rec = {
    ok: opened.status !== 'turn_busy',
    status: opened.status,
    created: opened.status === 'created',
    turn_id: opened.turn_id,
    conversation: opened.conv ?? conversationId,
  }
  if (opened.status === 'already_open') {
    value['state'] = opened.state
    if (opened.outcome !== null) value['outcome'] = opened.outcome
  }
  if (opened.status === 'turn_busy') {
    value['reason'] = 'turn_busy'
    value['busy_turn_id'] = opened.busy_turn_id
  }
  return { value, events }
}

/**
 * 追加一条步记录（intent / result / checkpoint），按 `(turn_id, type, seq)` 去重。
 * 先写意图再执行：追加失败不落内存、不视为已执行，并以 `refused{owner_unavailable}` 收口停止。
 */
async function stepAppend(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  void env
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const type = asString(args['type'])
  if (type === null || !STEP_APPEND_TYPES.has(type)) {
    return { value: { ok: false, reason: 'bad_record_type' }, events: [] }
  }
  const record: Rec = { ...args }
  const checked = validateStepRecord(record)
  if (!checked.ok) {
    return { value: { ok: false, reason: 'invalid_contract', outcome: checked.outcome }, events: [] }
  }
  const turnId = asString(args['turn_id'])
  const status = await deps.store.appendStep(record)
  if (status === 'failed') {
    const outcome = ownerUnavailable('turn step append failed')
    if (turnId !== null) await deps.store.settle(turnId, outcome as unknown as Rec)
    return { value: { ok: false, reason: 'owner_unavailable', outcome }, events: [] }
  }
  if (status === 'not_found') return { value: { ok: false, reason: 'unknown_turn' }, events: [] }
  if (status === 'not_open') return { value: { ok: false, reason: 'not_open' }, events: [] }
  return {
    value: { ok: true, turn_id: turnId, seq: args['seq'] ?? null, deduped: status === 'exists' },
    events: [],
  }
}

/**
 * 回合运行中插入一条用户消息：仅对 open 回合接受，按 `insert_id` 幂等。
 * 落 `step.user` 步——同回合投影据此在原位落一条用户消息（既进下一轮模型上下文，又进消息流），
 * 并广播 `thread.updated` 让 ui-chat 重拉历史。
 */
async function turnInsert(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  const insertId = asString(args['insert_id'])
  const message = isRecord(args['user_message']) ? (args['user_message'] as Rec) : null
  if (turnId === null || insertId === null || message === null) {
    return { value: { ok: false, reason: 'bad_args' }, events: [] }
  }
  const body: Rec = { ...message }
  if (body['at'] === undefined) body['at'] = isoAt(nowOf(env))
  const result = await deps.store.insertUserMessage(turnId, insertId, body)
  if (result.status === 'failed') return { value: { ok: false, reason: 'owner_unavailable' }, events: [] }
  if (result.status === 'not_found') return { value: { ok: false, reason: 'unknown_turn' }, events: [] }
  if (result.status === 'not_open') return { value: { ok: false, reason: 'not_open' }, events: [] }
  const conv = deps.store.conversationOfTurn(turnId)
  const events =
    conv === null
      ? []
      : [{ topic: 'thread.updated', payload: { ...conversationEvent(env, conv), changed: ['messages'] } }]
  return {
    value: { ok: true, turn_id: turnId, seq: result.seq, deduped: result.status === 'exists' },
    events,
  }
}

/**
 * 记一条待发输入（回合进行中用户想插入的消息）：只在会话内存标记，不落步、不渲染。
 * 图在轮次边界据此挂起；挂起后由 `turn_promote_input` 提升为 `step.user`（那一刻才落盘进流）。
 * 回执带 `noted`：回合非 open / 未知时未真记入，回 `noted:false`，调用方据此把消息留待续发而非静默丢弃。
 */
async function turnNoteInput(args: Json, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  const insertId = asString(args['insert_id'])
  const message = isRecord(args['user_message']) ? (args['user_message'] as Rec) : null
  if (turnId === null || insertId === null || message === null) {
    return { value: { ok: false, reason: 'bad_args' }, events: [] }
  }
  const noted = deps.store.notePendingInput(turnId, insertId, message)
  return { value: { ok: true, turn_id: turnId, noted }, events: [] }
}

/** 该回合是否有待发输入（图在轮次边界据此挂起）。回合未知 / 无输入都回 false。 */
async function turnHasPendingInput(args: Json, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  const pending = turnId !== null && deps.store.hasPendingInput(turnId)
  return { value: { ok: true, turn_id: turnId, pending }, events: [] }
}

/**
 * 段边界提升待发输入：把内存里的待发条目按序落为 `step.user`（追加在本段输出之后），
 * 有提升则广播重拉历史。这条路径即「消息进入流之后才落盘」。
 */
async function turnPromoteInput(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  if (turnId === null) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const entries = deps.store.takePendingInput(turnId)
  let promoted = 0
  for (const entry of entries) {
    const insertId = asString(entry['insert_id'])
    const message = isRecord(entry['user_message']) ? (entry['user_message'] as Rec) : null
    if (insertId === null || message === null) continue
    const result = await deps.store.insertUserMessage(turnId, insertId, message)
    if (result.status === 'inserted') promoted += 1
  }
  const conv = deps.store.conversationOfTurn(turnId)
  const events =
    promoted > 0 && conv !== null
      ? [{ topic: 'thread.updated', payload: { ...conversationEvent(env, conv), changed: ['messages'] } }]
      : []
  return { value: { ok: true, turn_id: turnId, promoted }, events }
}

/**
 * 回合收口：CAS 保护，只有开态 / interrupted 能被落定；终态被拒并记迟到日志。
 * `awaiting` 是段终态不是回合终态，`validateOutcome` 只认四种终态，天然拒绝。
 */
async function turnSettle(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  void env
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  if (turnId === null) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const checked = validateOutcome(args['outcome'])
  if (!checked.ok) {
    return { value: { ok: false, reason: 'invalid_contract', outcome: checked.outcome }, events: [] }
  }
  const outcome = checked.value
  const result = await deps.store.settle(turnId, outcome as unknown as Rec)
  if (result.status === 'unknown') return { value: { ok: false, reason: 'unknown_turn' }, events: [] }
  if (result.status === 'late') {
    return {
      value: { ok: false, reason: 'already_settled', rejected: true, persisted: result.persisted, outcome },
      events: [],
    }
  }
  return { value: { ok: true, turn_id: turnId, outcome, persisted: result.persisted }, events: [] }
}

/**
 * 记录取消意图：被取消的回合先落意图，重启收口据此判 `cancelled` 而非仅仅 `interrupted`。
 * 只记意图、不落终态——终态仍由 `turn_settle` 的 CAS 落定；已收口回合回其结局（no-op）。
 */
async function turnCancel(args: Json, env: CallEnv, deps: SessionDeps): Promise<HandlerResult> {
  void env
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  if (turnId === null) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const result = await deps.store.cancelTurn(turnId)
  if (result.status === 'unknown') return { value: { ok: false, reason: 'unknown_turn' }, events: [] }
  if (result.status === 'failed') return { value: { ok: false, reason: 'owner_unavailable' }, events: [] }
  const value: Rec = {
    ok: true,
    turn_id: turnId,
    state: result.status === 'settled' ? 'settled' : 'open',
    conversation: result.conv,
  }
  if (result.outcome !== null) value['outcome'] = result.outcome
  return { value, events: [] }
}

// ── read / history（服务读自有存储） ────────────────────────────────────────

function read(args: Rec, env: CallEnv, deps: SessionDeps): HandlerResult {
  void env
  const store = deps.store
  const record = isRecord(args) ? args : {}
  const turnId = asString(record['turn_id'])
  const turn = turnId === null ? null : store.turn(turnId)
  // 显式会话优先；否则按 `turn_id` 定位该回合所属会话（续跑子代理旁路线程时 `current` 仍是主会话）。
  const convId = asString(record['conversation']) ?? (turn !== null ? asString(turn['conv']) : null)
  return {
    value: {
      ...store.slice(convId),
      pending_turns: store.pendingTurns(),
      open_turns: store.openTurnSummaries(),
    },
    events: [],
  }
}

function history(args: Rec, env: CallEnv, deps: SessionDeps): HandlerResult {
  const record = isRecord(args) ? args : {}
  const query = {
    conversation: asString(record['conversation']) ?? asString(env.thread) ?? deps.store.currentId(),
    before: asString(record['before']),
    limit: typeof record['limit'] === 'number' && Number.isInteger(record['limit']) && record['limit'] > 0
      ? (record['limit'] as number)
      : null,
    full: record['full'] === true,
  }
  return {
    value: deps.store.history(query.conversation, query.before, query.limit, query.full),
    events: [],
  }
}

/**
 * 清单面（轻）：会话 body + 跨会话仍开着的回合摘要，不背消息 / 回合切片。
 * 供角标 / 顶栏 / 侧栏列表取数；引擎切片仍走 `read`。
 */
function list(args: Rec, env: CallEnv, deps: SessionDeps): HandlerResult {
  void args
  void env
  return {
    value: { ...deps.store.body(), open_turns: deps.store.openTurnSummaries() },
    events: [],
  }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

/** 构造方法表（依赖注入：反向调用通道 + 会话存储）。 */
export function createHandlers(deps: SessionDeps): Record<string, Handler> {
  return {
    commit: (args, env) => commit(requireArgs(args), env, deps),
    new_conversation: (args, env) => newConversation(requireArgs(args), env, deps),
    select: (args, env) => select(requireArgs(args), env, deps),
    rename: (args, env) => rename(requireArgs(args), env, deps),
    set_title: (args, env) => setTitle(requireArgs(args), env, deps),
    delete: (args, env) => deleteConversation(requireArgs(args), env, deps),
    restore: (args, env) => restore(requireArgs(args), env, deps),
    branch: (args, env) => branch(requireArgs(args), env, deps),
    deliver: (args, env) => deliver(requireArgs(args), env, deps),
    ack_inbox: (args, env) => ackInbox(requireArgs(args), env, deps),
    turn_open: (args, env) => turnOpen(args, env, deps),
    turn_insert: (args, env) => turnInsert(args, env, deps),
    turn_note_input: (args, _env) => turnNoteInput(args, deps),
    turn_has_pending_input: (args, _env) => turnHasPendingInput(args, deps),
    turn_promote_input: (args, env) => turnPromoteInput(args, env, deps),
    step_append: (args, env) => stepAppend(args, env, deps),
    turn_settle: (args, env) => turnSettle(args, env, deps),
    turn_cancel: (args, env) => turnCancel(args, env, deps),
    read: (args, env) => read(args, env, deps),
    list: (args, env) => list(args, env, deps),
    history: (args, env) => history(args, env, deps),
  }
}

function requireArgs(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}
