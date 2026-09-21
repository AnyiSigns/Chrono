// 能力类 `session` 的九个方法：只构造写计划 + 事件，不读投影、不落账、不自取时钟。
// 每个方法都把调用方入口 term 读出的世界数据（会话 body / 槽体 / refs）经 args 收进来。

import {
  addGenOp,
  asArray,
  asString,
  clearSlotsBody,
  conversationEvent,
  conversationsOf,
  countOf,
  externOnly,
  findConversation,
  headHash,
  isRecord,
  isoAt,
  messageBody,
  nowOf,
  optionalMessageFields,
  planOf,
  putOp,
  replaceConversation,
  slotOf,
  summaryOf,
  threadKeyOf,
  upsertConversation,
} from './plan.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json } from './types.ts'
import type { Rec } from './plan.ts'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'terminated'])

function requireRecord(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  return value
}

function requireSession(args: Rec): Rec {
  return requireRecord(args['session'], 'session')
}

function requireSlots(args: Rec): Rec {
  return requireRecord(args['slots'], 'slots')
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

/** 只清槽的失败计划：非法槽 kind / 目标不存在等，无业务写。 */
function clearOnly(slotsBody: Rec, threadId: string, payload: Json): HandlerResult {
  const ops = [putOp(clearSlotsBody(slotsBody, threadId)), addGenOp('input', 0)]
  return { value: planOf(ops, payload), events: [] }
}

/** 槽驱动的通用入口：校验 args 必备字段，解析线程键、槽体与槽 kind。 */
function slotContext(args: Rec): { session: Rec; slotsBody: Rec; threadId: string; slot: Json | undefined } {
  const threadId = threadKeyOf(args)
  return {
    session: requireSession(args),
    slotsBody: requireSlots(args),
    threadId,
    slot: slotOf(args, threadId),
  }
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
    head: null,
    count: 0,
    created: at,
    deleted_at: null,
  }
}

/** 软删后的 current 回退：同工作区最近一条未删会话（无则 null）。 */
function fallbackCurrent(session: Rec, removed: Rec, removedId: string): string | null {
  const list = conversationsOf(session)
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

function commit(args: Rec, env: CallEnv): HandlerResult {
  const now = nowOf(env)
  const at = isoAt(now)
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'chat.message') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const conversationId = asString(args['conversation']) ?? asString(session['current'])
  const conversation = conversationId === null ? null : findConversation(session, conversationId)
  if (conversation === null || conversationId === null) {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  }
  const error = asString(args['error'])
  if (error !== null) {
    return commitError({ args, env, at, session, slotsBody, threadId, conversationId, conversation, error })
  }
  return commitNormal({ args, env, at, session, slotsBody, threadId, conversationId, conversation, slot })
}

interface CommitContext {
  args: Rec
  env: CallEnv
  at: string
  session: Rec
  slotsBody: Rec
  threadId: string
  conversationId: string
  conversation: Rec
  slot?: Json
}

function commitNormal(ctx: CommitContext): HandlerResult {
  const { args, env, at, session, slotsBody, threadId, conversationId, conversation, slot } = ctx
  const count = countOf(conversation)
  const prevHash = headHash(conversation)
  const userSource = isRecord(args['user']) ? (args['user'] as Rec) : null
  const assistant = requireRecord(args['assistant'], 'assistant')
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const userContent = asString(userSource?.['content']) ?? asString(slotRec?.['text']) ?? ''
  const assistantContent = asString(assistant['content']) ?? ''
  const userExtra = optionalMessageFields(userSource)
  if (userExtra['attachments'] === undefined && Array.isArray(slotRec?.['attachments'])) {
    userExtra['attachments'] = slotRec['attachments']
  }
  const userBody = messageBody(
    'user',
    `msg-${conversationId}-${count}`,
    userContent,
    prevHash === null ? null : { def: prevHash },
    at,
    userExtra,
  )
  const assistantBody = messageBody(
    'assistant',
    `msg-${conversationId}-${count + 1}`,
    assistantContent,
    { def: { $n: 0 } },
    at,
    optionalMessageFields(assistant),
  )
  const inbox = inboxOf(conversation)
  const inboxCount = numberField(inbox, 'count') ?? 0
  const lastSeenArg = numberField(args, 'last_seen')
  // status 缺省保留原值：不得写入 null（schema 枚举不含 null）
  const status = asString(args['status']) ?? asString(conversation['status'])
  const nextConversation: Rec = {
    ...conversation,
    head: { def: { $n: 1 } },
    count: count + 2,
    last_activity: { at, summary: summaryOf(assistantContent) },
  }
  if (status !== null) nextConversation['status'] = status
  if (isRecord(conversation['inbox'])) {
    nextConversation['inbox'] = {
      ...inbox,
      last_seen: Math.max(numberField(inbox, 'last_seen') ?? 0, lastSeenArg ?? inboxCount),
    }
  }
  const nextSession = replaceConversation(session, conversationId, nextConversation)
  const ops = [
    putOp(userBody),
    putOp(assistantBody),
    putOp(nextSession),
    addGenOp('session', 2),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 4),
  ]
  const events = []
  const kind = asString(conversation['kind']) ?? 'main'
  if (kind === 'group') {
    events.push({
      topic: 'group.message',
      payload: { ...conversationEvent(env, conversationId), id: userBody['id'], seq: count, from: 'user' },
    })
  }
  events.push({
    topic: 'thread.updated',
    payload: { ...conversationEvent(env, conversationId), changed: ['head', 'count', 'last_activity'] },
  })
  const value = planOf(ops, { ok: true, reply: assistantBody, conversation: conversationId, count: count + 2 })
  return { value, events }
}

function commitError(ctx: CommitContext & { error: string }): HandlerResult {
  const { env, at, session, slotsBody, threadId, conversationId, conversation, error } = ctx
  const count = countOf(conversation)
  const prevHash = headHash(conversation)
  const systemBody = messageBody(
    'system',
    `msg-${conversationId}-${count}`,
    error,
    prevHash === null ? null : { def: prevHash },
    at,
    { meta: { error } },
  )
  const nextConversation: Rec = {
    ...conversation,
    head: { def: { $n: 0 } },
    count: count + 1,
    last_activity: { at, summary: summaryOf(error) },
  }
  const nextSession = replaceConversation(session, conversationId, nextConversation)
  const ops = [
    putOp(systemBody),
    putOp(nextSession),
    addGenOp('session', 1),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 3),
  ]
  const events = [
    {
      topic: 'thread.updated',
      payload: { ...conversationEvent(env, conversationId), changed: ['head', 'count', 'last_activity'] },
    },
  ]
  const value = planOf(ops, { ok: false, error, conversation: conversationId })
  return { value, events }
}

// ── new_conversation / select / rename / set_title ─────────────────────────

function newConversation(args: Rec, env: CallEnv): HandlerResult {
  const now = nowOf(env)
  const at = isoAt(now)
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.new') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const workspaceId = asString(args['workspace_id']) ?? asString(slotRec?.['workspace_id'])
  const title = asString(args['title']) ?? '新对话'
  const id = asString(args['conversation_id']) ?? `c-${now}-${conversationsOf(session).length}`
  const entry = newConversationEntry(id, workspaceId, title, at, 'main')
  const nextSession: Rec = {
    ...session,
    current: id,
    conversations: [...conversationsOf(session), entry],
  }
  const ops = [
    putOp(nextSession),
    addGenOp('session', 0),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 2),
  ]
  const events = [
    { topic: 'thread.opened', payload: { ...conversationEvent(env, id), kind: 'main' } },
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['current'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: id }), events }
}

function select(args: Rec, env: CallEnv): HandlerResult {
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.select') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? asString(session['current'])
  if (id === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = findConversation(session, id)
  if (conversation === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'not_found' })
  if (conversation['deleted_at'] !== null && conversation['deleted_at'] !== undefined) {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'deleted' })
  }
  const nextSession: Rec = { ...session, current: id }
  const ops = [
    putOp(nextSession),
    addGenOp('session', 0),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 2),
  ]
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['current'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: id }), events }
}

function rename(args: Rec, env: CallEnv): HandlerResult {
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.rename') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? asString(session['current'])
  const title = asString(args['title']) ?? asString(slotRec?.['title'])
  if (id === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  if (title === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'missing_title' })
  const conversation = findConversation(session, id)
  if (conversation === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'not_found' })
  const nextSession = replaceConversation(session, id, { ...conversation, title })
  const ops = [
    putOp(nextSession),
    addGenOp('session', 0),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 2),
  ]
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['title'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: id, title }), events }
}

/** 服务调用路径：args 驱动、不经输入槽、不清槽；无条件写入（首条判定在调用方入口 term）。 */
function setTitle(args: Rec, env: CallEnv): HandlerResult {
  const session = requireSession(args)
  const id = asString(args['conversation'])
  const title = asString(args['title'])
  if (id === null) throw new BadArgsError('conversation required')
  if (title === null) throw new BadArgsError('title required')
  const conversation = findConversation(session, id)
  if (conversation === null) {
    return { value: externOnly({ ok: false, reason: 'not_found', conversation: id }), events: [] }
  }
  const nextSession = replaceConversation(session, id, { ...conversation, title })
  const ops = [putOp(nextSession), addGenOp('session', 0)]
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['title'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: id, title }), events }
}

// ── delete / restore / branch ──────────────────────────────────────────────

function deleteConversation(args: Rec, env: CallEnv): HandlerResult {
  const now = nowOf(env)
  const at = isoAt(now)
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.delete') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? asString(session['current'])
  if (id === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = findConversation(session, id)
  if (conversation === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'not_found' })
  const nextConversation: Rec = { ...conversation, deleted_at: at }
  const currentChanged = asString(session['current']) === id
  const nextCurrent = currentChanged ? fallbackCurrent(session, conversation, id) : (session['current'] ?? null)
  const nextSession: Rec = {
    ...replaceConversation(session, id, nextConversation),
    current: nextCurrent,
  }
  const ops = [
    putOp(nextSession),
    addGenOp('session', 0),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 2),
  ]
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
  return { value: planOf(ops, { ok: true, conversation: id, current: nextCurrent }), events }
}

function restore(args: Rec, env: CallEnv): HandlerResult {
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.restore') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const id = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? asString(session['current'])
  if (id === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  const conversation = findConversation(session, id)
  if (conversation === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'not_found' })
  const nextSession = replaceConversation(session, id, { ...conversation, deleted_at: null })
  const ops = [
    putOp(nextSession),
    addGenOp('session', 0),
    putOp(clearSlotsBody(slotsBody, threadId)),
    addGenOp('input', 2),
  ]
  const events = [
    { topic: 'thread.updated', payload: { ...conversationEvent(env, id), changed: ['deleted_at'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: id }), events }
}

/** 把源消息引用解析成 refs 里的 def 哈希：优先当哈希键，否则按消息 id 找。 */
function resolveMessageHash(refs: Rec, ref: string): string | null {
  if (Object.hasOwn(refs, ref) && isRecord(refs[ref])) return ref
  for (const hash of Object.keys(refs)) {
    const body = refs[hash]
    if (isRecord(body) && body['id'] === ref) return hash
  }
  return null
}

/** 沿 prev 链从链头回溯到链首，返回 oldest→newest 中截至目标消息的前缀；不在链上返回 null。 */
function chainTo(refs: Rec, head: string | null, target: string): string[] | null {
  if (head === null) return null
  const backwards: string[] = []
  const seen = new Set<string>()
  let current: string | null = head
  while (current !== null) {
    if (seen.has(current)) return null
    seen.add(current)
    const body = refs[current]
    if (!isRecord(body)) return null
    backwards.push(current)
    const prev = body['prev']
    current = isRecord(prev) && typeof prev['def'] === 'string' ? prev['def'] : null
  }
  const forward = backwards.reverse()
  const index = forward.indexOf(target)
  if (index < 0) return null
  return forward.slice(0, index + 1)
}

function branch(args: Rec, env: CallEnv): HandlerResult {
  const now = nowOf(env)
  const at = isoAt(now)
  const { session, slotsBody, threadId, slot } = slotContext(args)
  if (slotKind(slot) !== 'session.branch') {
    return clearOnly(slotsBody, threadId, { ok: false, reason: 'bad_slot_kind', kind: slotKind(slot) })
  }
  const slotRec = isRecord(slot) ? (slot as Rec) : null
  const sourceId = asString(args['conversation']) ?? asString(slotRec?.['conversation']) ?? asString(session['current'])
  const messageRef = asString(args['message']) ?? asString(slotRec?.['message'])
  if (sourceId === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'no_conversation' })
  if (messageRef === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'missing_message' })
  const source = findConversation(session, sourceId)
  if (source === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'not_found' })
  const refs = isRecord(args['refs']) ? (args['refs'] as Rec) : {}
  const targetHash = resolveMessageHash(refs, messageRef)
  if (targetHash === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'message_not_found' })
  const chain = chainTo(refs, headHash(source), targetHash)
  if (chain === null) return clearOnly(slotsBody, threadId, { ok: false, reason: 'message_not_in_chain' })

  const newId = asString(args['conversation_id']) ?? `c-${now}-${conversationsOf(session).length}`
  const ops: Json[] = []
  chain.forEach((hash, index) => {
    const body = refs[hash]
    const prev = index === 0 ? null : { def: { $n: index - 1 } }
    ops.push(putOp({ ...(body as Rec), prev }))
  })
  const lastIndex = chain.length - 1
  const entry: Rec = {
    id: newId,
    workspace_id: source['workspace_id'] ?? null,
    title: `${asString(source['title']) ?? '新对话'}（分支）`,
    kind: asString(source['kind']) ?? 'main',
    parent: { def: sourceId },
    // 分支源消息：消息 id 或 def 哈希（与入参 message 同形），随会话条目持久化
    source_message: messageRef,
    agent: source['agent'] ?? null,
    participants: asArray(source['participants']) ?? [],
    workflow: source['workflow'] ?? null,
    inbox: { tail: null, count: 0, last_seen: 0 },
    status: 'waiting',
    last_activity: null,
    pending: { approval: 0, question: 0 },
    head: lastIndex >= 0 ? { def: { $n: lastIndex } } : null,
    count: chain.length,
    created: at,
    deleted_at: null,
  }
  const bodyIndex = ops.length
  const nextSession: Rec = {
    ...session,
    current: newId,
    conversations: [...conversationsOf(session), entry],
  }
  ops.push(putOp(nextSession))
  ops.push(addGenOp('session', bodyIndex))
  ops.push(putOp(clearSlotsBody(slotsBody, threadId)))
  ops.push(addGenOp('input', bodyIndex + 2))
  const events = [
    {
      topic: 'thread.opened',
      payload: { ...conversationEvent(env, newId), kind: entry['kind'], source: sourceId, message: targetHash },
    },
    { topic: 'thread.updated', payload: { ...conversationEvent(env, newId), changed: ['current'] } },
  ]
  return { value: planOf(ops, { ok: true, conversation: newId, count: chain.length }), events }
}

// ── deliver（跨线程投递） ───────────────────────────────────────────────────

function workflowPosition(workflow: Json | undefined): { node_index: number | null; iter: number | null } {
  if (!isRecord(workflow)) return { node_index: null, iter: null }
  return { node_index: numberField(workflow as Rec, 'node_index'), iter: numberField(workflow as Rec, 'iter') }
}

function deliver(args: Rec, env: CallEnv): HandlerResult {
  const now = nowOf(env)
  const at = isoAt(now)
  const session = requireSession(args)
  const to = asString(args['to'])
  const kind = asString(args['kind'])
  if (to === null) throw new BadArgsError('to required')
  if (kind === null) throw new BadArgsError('kind required')
  if (!Object.hasOwn(args, 'body')) throw new BadArgsError('body required')
  const messageBodyValue: Json = args['body'] ?? null
  const refs = asArray(args['refs'])

  const existing = findConversation(session, to)
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
      head: null,
      count: 0,
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
  if (refs !== null) inboxMessage['refs'] = refs

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
    inbox: { tail: { def: { $n: 0 } }, count: seq, last_seen: lastSeen },
    status,
    last_activity: lastActivity,
    pending,
    workflow,
  }
  const nextSession = upsertConversation(session, nextConversation)
  const ops = [putOp(inboxMessage), putOp(nextSession), addGenOp('session', 1)]

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
  const value = planOf(ops, { ok: true, to, seq, status, kind })
  return { value, events }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

export const HANDLERS: Record<string, Handler> = {
  commit,
  new_conversation: newConversation,
  select,
  rename,
  set_title: setTitle,
  delete: deleteConversation,
  restore,
  branch,
  deliver,
}
