// 计划构造与共享纯函数：只返回写计划（`$directives`）与事件，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import type { CallEnv, Json } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

/** 缺省线程键（per-thread 键控：清槽只清本键）。 */
export const MAIN_THREAD = '_main'

export type Rec = { [key: string]: Json }

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 帧 env 的固定时钟；env 缺失（不该发生）时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（last_activity.summary / 事件载荷用）。 */
export function summaryOf(value: Json, limit = 120): string {
  let text = ''
  if (typeof value === 'string') text = value
  else if (isRecord(value) && typeof value['content'] === 'string') text = value['content']
  else text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/**
 * 单条 add_gen 子操作：payload / sig 指向同批更早的 put。
 * `base` 存在即补丁世代（base = 同身份基础世代下标）；缺省为整份世代。
 */
export function addGenOp(id: string, index: number, base?: number): Json {
  const args: Rec = { id, payload: { $n: index }, sig: { $n: index }, pins: {} }
  if (base !== undefined) args['base'] = base
  return { op: 'add_gen', args }
}

/** 投影切片里本身份最近数据世代的下标（无数据世代 → null，写整份世代）。 */
export function baseSeqOf(session: Rec): number | null {
  const dataGen = session['data_gen']
  if (!isRecord(dataGen)) return null
  const seq = dataGen['seq']
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

/** JSON 结构相等（与内核 canonical 口径一致的简化版：键序无关、类型严格）。 */
function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  }
  return false
}

/**
 * 会话 body 的补丁：以 base 为起点把 prev 变换为 next。
 * conversations 按 id 对齐：缺者删除（降序，防索引漂移）、变者按位替换、新者追加；
 * 其余顶层字段逐个 replace / delete。补丁语义保证组装结果与直接写整份 next 逐字段一致。
 */
export function sessionPatches(prev: Rec, next: Rec): Json[] {
  const ops: Json[] = []
  const prevList = conversationsOf(prev)
  const nextList = conversationsOf(next)
  const prevIndexById = new Map<string, number>()
  prevList.forEach((item, index) => {
    if (isRecord(item) && typeof item['id'] === 'string') prevIndexById.set(item['id'], index)
  })
  const nextIds = new Set<string>()
  nextList.forEach((item) => {
    if (isRecord(item) && typeof item['id'] === 'string') nextIds.add(item['id'])
  })
  const deleted = [...prevIndexById.entries()]
    .filter(([id]) => !nextIds.has(id))
    .map(([, index]) => index)
    .sort((a, b) => b - a)
  for (const index of deleted) ops.push({ op: 'delete', path: ['conversations', index] })
  const deletedBelow = (index: number): number => deleted.filter((item) => item < index).length
  nextList.forEach((item) => {
    const id = isRecord(item) && typeof item['id'] === 'string' ? item['id'] : null
    const prevIndex = id === null ? undefined : prevIndexById.get(id)
    if (prevIndex === undefined) {
      ops.push({ op: 'append', path: ['conversations'], value: item })
    } else if (!jsonEqual(prevList[prevIndex], item)) {
      ops.push({ op: 'replace', path: ['conversations', prevIndex - deletedBelow(prevIndex)], value: item })
    }
  })
  for (const key of Object.keys(next)) {
    if (key === 'conversations') continue
    if (!jsonEqual(prev[key], next[key])) ops.push({ op: 'replace', path: [key], value: next[key] })
  }
  for (const key of Object.keys(prev)) {
    if (key === 'conversations' || Object.hasOwn(next, key)) continue
    ops.push({ op: 'delete', path: [key] })
  }
  return ops
}

/**
 * 追加会话世代的写子操作：有数据世代（baseSeq）写补丁世代，否则写整份世代。
 * 调用方在调用前取 `ops.length` 作为 put 下标（本函数内部完成 push）。
 */
export function pushSessionGen(ops: Json[], session: Rec, nextSession: Rec): void {
  const base = baseSeqOf(session)
  const index = ops.length
  if (base !== null) {
    const patches = sessionPatches(sessionDataOf(session), nextSession)
    // 无变更（空补丁）时回落整份世代：补丁体不允许空 ops，且行为与旧整份写一致（仍产新世代）
    if (patches.length > 0) {
      ops.push(putOp({ ops: patches }))
      ops.push(addGenOp('session', index, base))
      return
    }
  }
  ops.push(putOp(nextSession))
  ops.push(addGenOp('session', index))
}

/** 一条原子 batch write 计划条目。 */
export function batchDirective(ops: Json[]): Json {
  return { kind: 'write', request: { op: 'batch', args: { ops } } }
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 组装最终计划值：一条 batch + 一条 extern。 */
export function planOf(ops: Json[], payload: Json): Json {
  return { $directives: [batchDirective(ops), externDirective(payload)] }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 会话列表（数组）；缺失 / 非数组返回空数组。 */
export function conversationsOf(session: Rec): Json[] {
  const list = session['conversations']
  return Array.isArray(list) ? list : []
}

/**
 * 会话数据 body 的**规范形状**：只留数据字段（`version` / `current` / `conversations` / `messageDef`）。
 * 投影对无数据世代的身份回落**代码 commit body**（含字符串 `tree` / `meta` / `refs`）；若原样继承，
 * `isCodeGen`（据 `body.tree` 为字符串）会把该数据世代误判为代码世代——宿主据此对**数据变更**触发
 * 无谓的服务换代重载。故所有会话写一律以本函数归一后的 body 为基，剥掉代码体残留。
 */
export function sessionDataOf(session: Rec): Rec {
  const out: Rec = {}
  out['version'] = session['version'] ?? 1
  out['current'] = session['current'] ?? null
  out['conversations'] = conversationsOf(session)
  if (session['messageDef'] !== undefined) out['messageDef'] = session['messageDef']
  return out
}

export function findConversation(session: Rec, id: string): Rec | null {
  for (const item of conversationsOf(session)) {
    if (isRecord(item) && item['id'] === id) return item
  }
  return null
}

/** 会话条目的链头哈希；无头 / 形态非法返回 null。 */
export function headHash(conversation: Rec): string | null {
  const head = conversation['head']
  if (!isRecord(head)) return null
  const hash = head['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
}

/** 会话条目计数（非负整数）；缺失 / 非法返回 0。 */
export function countOf(conversation: Rec): number {
  const count = conversation['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
}

/** 替换会话列表中的一条（按 id）。 */
export function replaceConversation(session: Rec, id: string, next: Rec): Rec {
  const list = conversationsOf(session).map((item) =>
    isRecord(item) && item['id'] === id ? next : item,
  )
  return { ...sessionDataOf(session), conversations: list }
}

/** 新增或替换一条会话（按 id）。 */
export function upsertConversation(session: Rec, next: Rec): Rec {
  const list = conversationsOf(session)
  const exists = list.some((item) => isRecord(item) && item['id'] === next['id'])
  const conversations = exists
    ? list.map((item) => (isRecord(item) && item['id'] === next['id'] ? next : item))
    : [...list, next]
  return { ...sessionDataOf(session), conversations }
}

/** 线程键：args.thread_id 非空字符串，否则 `_main`。 */
export function threadKeyOf(args: Rec): string {
  return asString(args['thread_id']) ?? MAIN_THREAD
}

/** 本线程槽体：args.slot 优先，否则从 args.slots.slots[threadId] 取。 */
export function slotOf(args: Rec, threadId: string): Json | undefined {
  if (args['slot'] !== undefined) return args['slot']
  const body = args['slots']
  if (!isRecord(body)) return undefined
  const slots = body['slots']
  if (!isRecord(slots)) return undefined
  return slots[threadId]
}

/**
 * 输入 body 的**规范形状**：只留 `slots`。入口切片可能把 `data_gen` / `refs` 等投影元数据并进同一层，
 * 直接继承会把它们写回世界 body；故所有输入写一律以本函数归一后的 body 为基。
 */
export function inputDataOf(slice: Rec): Rec {
  return { slots: isRecord(slice['slots']) ? (slice['slots'] as Rec) : {} }
}

/**
 * 清槽：per-thread 键控——只把本线程键置 `{kind:'idle'}`，其余键原样保留。
 * 返回**新对象**，不改入参（入参是轮首投影的整份 body / 入口切片）。
 */
export function clearSlotsBody(slotsBody: Rec, threadId: string): Rec {
  const slots = isRecord(slotsBody['slots']) ? (slotsBody['slots'] as Rec) : {}
  return { slots: { ...slots, [threadId]: { kind: 'idle' } } }
}

/**
 * 追加输入世代的写子操作：有数据世代（`slice.data_gen`）且本线程槽确有变化 ⇒ 写 `replace ['slots', <thread>]`
 * 补丁世代；否则回落整份世代。调用方在调用前取 `ops.length` 作为 put 下标（本函数内部完成 push）。
 */
export function pushInputGen(ops: Json[], slice: Rec, threadId: string): void {
  const index = ops.length
  const base = baseSeqOf(slice)
  const prev = inputDataOf(slice)
  const slots = isRecord(prev['slots']) ? (prev['slots'] as Rec) : {}
  const nextSlot: Json = { kind: 'idle' }
  if (base !== null && !jsonEqual(slots[threadId], nextSlot)) {
    ops.push(putOp({ ops: [{ op: 'replace', path: ['slots', threadId], value: nextSlot }] }))
    ops.push(addGenOp('input', index, base))
    return
  }
  ops.push(putOp(clearSlotsBody(slice, threadId)))
  ops.push(addGenOp('input', index))
}

/** 一条消息 def body。`prev` 为 null / 字面 `{def:hash}` / 批内占位 `{def:{$n:k}}`。 */
export function messageBody(
  role: string,
  id: string,
  content: string,
  prev: Json,
  at: string,
  extra?: Rec,
): Rec {
  const body: Rec = { id, role, content, at, prev }
  if (extra !== undefined) {
    for (const key of Object.keys(extra)) {
      if (extra[key] !== undefined) body[key] = extra[key]
    }
  }
  return body
}

/** 把可选的 parts / attachments / meta 收进 extra（缺省不落键）。 */
export function optionalMessageFields(source: Rec | null): Rec {
  const extra: Rec = {}
  if (source !== null) {
    if (Array.isArray(source['parts'])) extra['parts'] = source['parts']
    if (Array.isArray(source['attachments'])) extra['attachments'] = source['attachments']
    if (isRecord(source['meta'])) extra['meta'] = source['meta']
  }
  return extra
}

/**
 * 数据变更类事件基座（`thread.*` / `workflow.step` / `group.message`）：
 * `thread` = **目标线程**（不是发起 run 的 thread），`conversation` 保留同值。
 * 对齐「UI 按当前视图线程过滤」口径：数据变更通知必须能落到被改的线程上。
 */
export function conversationEvent(env: CallEnv, conversationId: string | null): Rec {
  return { run: env.run, thread: conversationId, conversation: conversationId }
}
