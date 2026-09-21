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

/** 单条 add_gen 子操作：payload / sig 指向同批更早的 put（四字段全必填）。 */
export function addGenOp(id: string, index: number): Json {
  return { op: 'add_gen', args: { id, payload: { $n: index }, sig: { $n: index }, pins: {} } }
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
  return { ...session, conversations: list }
}

/** 新增或替换一条会话（按 id）。 */
export function upsertConversation(session: Rec, next: Rec): Rec {
  const list = conversationsOf(session)
  const exists = list.some((item) => isRecord(item) && item['id'] === next['id'])
  const conversations = exists
    ? list.map((item) => (isRecord(item) && item['id'] === next['id'] ? next : item))
    : [...list, next]
  return { ...session, conversations }
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
 * 清槽：per-thread 键控——只把本线程键置 `{kind:'idle'}`，其余键原样保留。
 * 返回**新对象**，不改入参（入参是轮首投影的整份 body）。
 */
export function clearSlotsBody(slotsBody: Rec, threadId: string): Rec {
  const slots = isRecord(slotsBody['slots']) ? (slotsBody['slots'] as Rec) : {}
  return { ...slotsBody, slots: { ...slots, [threadId]: { kind: 'idle' } } }
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
