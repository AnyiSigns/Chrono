// 计划构造与共享纯函数：只返回写计划（`$directives`）与事件，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op:'batch', args:{ops}}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import type { CallEnv, Json } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

/** 缺省线程键（per-thread 键控：清槽只清本键）。 */
export const MAIN_THREAD = '_main'

/** 遍历 item 链的硬上限（防坏数据成环）。 */
export const MAX_CHAIN = 10000

export type Rec = { [key: string]: Json }

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 非负整数；缺失 / 非法返回 null。 */
export function asCount(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失（不该发生）时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（args_ref.summary / 事件载荷用）。 */
export function summaryOf(value: Json, limit = 200): string {
  let text = ''
  if (typeof value === 'string') text = value
  else text = JSON.stringify(value) ?? ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/** 单条 add_gen 子操作：payload / sig 指向同批更早的 put；`base` 存在即补丁世代。 */
export function addGenOp(id: string, index: number, base?: number): Json {
  const args: Rec = { id, payload: { $n: index }, sig: { $n: index }, pins: {} }
  if (base !== undefined) args['base'] = base
  return { op: 'add_gen', args }
}

/** JSON 结构相等（键序无关、类型严格）。 */
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

/** 数据世代基准：切片上的 `data_gen.seq`（含 `body.data_gen` 包裹形态）；无 → null，写整份世代。 */
export function baseSeqOf(slice: Rec): number | null {
  for (const candidate of [slice, isRecord(slice['body']) ? (slice['body'] as Rec) : null]) {
    if (candidate === null) continue
    const dataGen = candidate['data_gen']
    if (!isRecord(dataGen)) continue
    const seq = dataGen['seq']
    if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq
  }
  return null
}

/** 顶层字段补丁：变者 replace、缺者 delete；不变者不产 op。 */
export function bodyPatches(prev: Rec, next: Rec): Json[] {
  const ops: Json[] = []
  for (const key of Object.keys(next)) {
    if (!jsonEqual(prev[key], next[key])) ops.push({ op: 'replace', path: [key], value: next[key] })
  }
  for (const key of Object.keys(prev)) {
    if (key in next) continue
    ops.push({ op: 'delete', path: [key] })
  }
  return ops
}

/**
 * 追加数据世代的写子操作：有数据世代（base）且补丁非空 ⇒ put(补丁) + add_gen(base)；
 * 否则整份 put + add_gen。调用方在调用前取 `ops.length` 作为 put 下标（本函数内部完成 push）。
 */
export function pushBodyGen(ops: Json[], id: string, prev: Rec, next: Rec, base: number | null): void {
  const index = ops.length
  if (base !== null) {
    const patches = bodyPatches(prev, next)
    if (patches.length > 0) {
      ops.push(putOp({ ops: patches }))
      ops.push(addGenOp(id, index, base))
      return
    }
  }
  ops.push(putOp(next))
  ops.push(addGenOp(id, index))
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

/** 显式 def 引用标记 `{"def":"<hash>"}`。 */
export function refOf(hash: string): Rec {
  return { def: hash }
}

/** 从 def 引用 / 裸哈希取哈希；形态非法返回 null。 */
export function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return HASH_RE.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
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
 * 输入 body 的规范形状：只留 `slots`（剥离入口切片并进来的 `data_gen` / `refs`）。
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

// ── 队列 body / item 链 ─────────────────────────────────────────────────────

/** 队列 body；缺失 / 非法回落空队列。 */
export function queueOf(args: Rec): Rec {
  const queue = args['queue']
  if (isRecord(queue)) return queue
  return { version: 1, tail: null, count: 0 }
}

/** 累计入队数；缺失 / 非法返回 0。 */
export function countOf(queue: Rec): number {
  return asCount(queue['count']) ?? 0
}

/** 投影引用闭包 `{hash: body}`；缺失 / 非法返回空表。 */
export function refsOf(args: Rec): Rec {
  const refs = args['refs']
  return isRecord(refs) ? refs : {}
}

/**
 * 沿 `prev` 链从 `queue.tail` 回溯，按 id 去重（**新版本在前**，故首个出现即最新版本）。
 * 返回 newest→oldest 的 item body 数组；坏引用 / 成环即停。
 */
export function itemsFromChain(queue: Rec, refs: Rec): Rec[] {
  const items: Rec[] = []
  const seen = new Set<string>()
  let current = defHashOf(queue['tail'])
  let guard = 0
  while (current !== null && guard < MAX_CHAIN) {
    guard += 1
    const body = refs[current]
    if (!isRecord(body)) break
    const id = asString(body['id'])
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      items.push(body)
    }
    current = defHashOf(body['prev'])
  }
  return items
}

/** 按 id 找最新版本 item；找不到返回 null。 */
export function itemById(items: Rec[], id: string): Rec | null {
  for (const item of items) {
    if (item['id'] === id) return item
  }
  return null
}

export function statusOf(item: Rec): string | null {
  return asString(item['status'])
}

// ── item 字段规范化 ─────────────────────────────────────────────────────────

const KINDS = new Set(['tool_call', 'orchestration_change', 'plugin_write'])

export function normalizeKind(value: Json | undefined): string | null {
  const kind = asString(value)
  return kind !== null && KINDS.has(kind) ? kind : null
}

/** 实际提供者能力类名：显式 port 优先，否则按 kind 取默认。 */
export function resolvePort(kind: string, port: Json | undefined): string {
  const explicit = asString(port)
  if (explicit !== null) return explicit
  if (kind === 'orchestration_change') return 'orchestration-admin'
  if (kind === 'plugin_write') return 'plugin-admin'
  return 'tool'
}

/**
 * 调用描述：只收调用方显式给出的资产引用或摘要，不内联大 args、不把明文 args 转写进世界
 * （明文密钥可能就在 args 里，故缺省即 null，绝不从任意 args 合成摘要）。
 */
export function normalizeArgsRef(value: Json | undefined): Rec | null {
  if (typeof value === 'string' && value.length > 0) return { summary: summaryOf(value) }
  if (!isRecord(value)) return null
  const sha256 = asString(value['sha256'])
  if (sha256 !== null) return { sha256 }
  const summary = asString(value['summary'])
  if (summary !== null) return { summary }
  return null
}

/** 续跑依据：`{command:'chat.resume', args:{cursor, thread}}`；无 cursor 时 null。 */
export function buildResume(args: Rec, thread: string): Rec | null {
  if (!Object.hasOwn(args, 'cursor')) return null
  const cursor = args['cursor']
  if (cursor === null || cursor === undefined) return null
  return { command: 'chat.resume', args: { cursor, thread } }
}

/** 影子回放指标 def 引用；非法返回 null。 */
export function normalizeShadow(value: Json | undefined): Rec | null {
  const hash = defHashOf(value)
  return hash === null ? null : refOf(hash)
}

/** verdict 槽词汇 → item 结果态（写死映射）。 */
export function verdictToStatus(verdict: string | null): string | null {
  if (verdict === 'accept') return 'approved'
  if (verdict === 'deny') return 'denied'
  return null
}
