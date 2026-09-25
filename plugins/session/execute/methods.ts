// 能力类 `session` 的方法：会话运行记录（消息链 + 会话元数据）写**自有持久存储**（④），
// 不再构造世界写计划、不读投影。写即时落盘（边跑边追加），每条消息盖回合 id 供幂等收敛。
// 服务仍不读投影、不自取时钟（`now` 取调用帧 `env.now`）；槽清理由 input 服务承担。

import { SessionStore } from './store.ts'
import type { Rec } from './store.ts'
import {
  asArray,
  asString,
  conversationEvent,
  conversationsOf,
  isRecord,
  isoAt,
  messageBody,
  nowOf,
  optionalMessageFields,
  summaryOf,
  threadKeyOf,
} from './plan.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller } from './types.ts'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'terminated'])

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
): Rec {
  return {
    id,
    workspace_id: workspaceId,
    title,
    kind,
    parent: null,
    agent: null,
    participants: [],
    workflow: null,
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
    workflow: source['workflow'] ?? null,
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

function workflowPosition(workflow: Json | undefined): { node_index: number | null; iter: number | null } {
  if (!isRecord(workflow)) return { node_index: null, iter: null }
  return { node_index: numberField(workflow as Rec, 'node_index'), iter: numberField(workflow as Rec, 'iter') }
}

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
      workflow: isRecord(args['workflow']) ? args['workflow'] : null,
      inbox: { tail: null, count: 0, last_seen: 0 },
      status: asString(args['status']) ?? 'running',
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
  const previousWorkflow = conversation['workflow']
  const workflow = isRecord(args['workflow']) ? args['workflow'] : previousWorkflow ?? null
  const lastActivity = isRecord(args['last_activity']) ? args['last_activity'] : { at, summary: summaryOf(messageBodyValue) }
  const lastSeenArg = numberField(args, 'last_seen')
  const lastSeen = Math.max(numberField(inbox, 'last_seen') ?? 0, lastSeenArg ?? (numberField(inbox, 'last_seen') ?? 0))

  const nextConversation: Rec = {
    ...conversation,
    inbox: { tail: { def: inboxMessage['id'] }, count: seq, last_seen: lastSeen },
    status,
    last_activity: lastActivity,
    pending,
    workflow,
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
  const before = workflowPosition(previousWorkflow)
  const after = workflowPosition(workflow)
  if (before.node_index !== after.node_index || before.iter !== after.iter) {
    events.push({
      topic: 'workflow.step',
      payload: { ...conversationEvent(env, to), node_index: after.node_index, iter: after.iter },
    })
  }
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

// ── read / history（服务读自有存储） ────────────────────────────────────────

function read(args: Rec, env: CallEnv, deps: SessionDeps): HandlerResult {
  void env
  const convId = isRecord(args) ? asString(args['conversation']) : null
  const store = deps.store
  return {
    value: {
      ...store.slice(convId),
      pending_turns: store.pendingTurns(),
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
  }
  return { value: deps.store.history(query.conversation, query.before, query.limit), events: [] }
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
    read: (args, env) => read(args, env, deps),
    history: (args, env) => history(args, env, deps),
  }
}

function requireArgs(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}
