// 计划构造与共享纯函数：只返回写计划（`$directives`）与事件，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'eval', command, args}` / `{kind:'write', request:{op, args}}` /
// `{kind:'extern', payload}`；占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

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

export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
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

/**
 * 一条按命令名解析入口的 eval 计划条目（宿主 plan 通道，H18）。
 * `inject` = 宿主在执行期把投影片段按声明路径并入 args（键 → 投影路径）；续跑 eval 用它拿投影。
 */
export function evalCommandDirective(command: string, args: Json, inject?: Rec): Json {
  const directive: Rec = { kind: 'eval', command, args }
  if (inject !== undefined) directive['inject'] = inject
  return directive
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

/** 队列链头引用 `{def:<hash>}` 或 null。 */
export function prevOf(queue: Rec): Json {
  const hash = defHashOf(queue['tail'])
  return hash === null ? null : refOf(hash)
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
    if (seen.has(current)) break
    seen.add(current)
    const body = refs[current]
    if (!isRecord(body)) break
    const id = asString(body['id'])
    if (id !== null && !items.some((item) => item['id'] === id)) items.push(body)
    current = defHashOf(body['prev'])
  }
  return items
}

/** 沿 `prev` 链按 id 定位 item，返回其 def 哈希与 body；找不到返回 null。 */
export function locateItem(queue: Rec, refs: Rec, id: string): { hash: string; item: Rec } | null {
  const seen = new Set<string>()
  let current = defHashOf(queue['tail'])
  let guard = 0
  while (current !== null && guard < MAX_CHAIN) {
    guard += 1
    if (seen.has(current)) break
    seen.add(current)
    const body = refs[current]
    if (!isRecord(body)) break
    if (body['id'] === id) return { hash: current, item: body }
    current = defHashOf(body['prev'])
  }
  return null
}

/** 按 id 找最新版本 item；找不到返回 null。 */
export function itemById(items: Rec[], id: string): Rec | null {
  for (const item of items) {
    if (item['id'] === id) return item
  }
  return null
}

/** 线程键：args.thread_id 非空字符串，否则 `_main`。 */
export function threadKeyOf(args: Rec): string {
  return asString(args['thread_id']) ?? MAIN_THREAD
}

/** 输入 body 的规范形状：只留 `slots`（剥离入口切片并进来的 `data_gen` / `refs`）。 */
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

/**
 * 续跑依据：`{command:'chat.resume', args:{cursor, thread}}`。
 * cursor 由调用方（#33 执行游标）随 bag 传入，不透明透传；无 cursor 时 null（本 run 无法续跑）。
 */
export function buildResume(args: Rec, thread: string): Rec | null {
  if (!Object.hasOwn(args, 'cursor')) return null
  const cursor = args['cursor']
  if (cursor === null || cursor === undefined) return null
  const resumeArgs: Rec = { cursor, thread }
  if (args['iter'] !== undefined) resumeArgs['iter'] = args['iter']
  if (args['slots'] !== undefined) resumeArgs['slots'] = args['slots']
  return { command: 'chat.resume', args: resumeArgs }
}
