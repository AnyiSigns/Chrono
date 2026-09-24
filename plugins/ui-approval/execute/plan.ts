// 计划构造与共享纯函数：只返回写计划（`$directives`）与数据，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'eval', command, args}` / `{kind:'write', request:{op, args}}` /
// `{kind:'extern', payload}`；占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export type Rec = { [key: string]: Json }

/** 缺省线程键（per-thread 键控：写 / 清槽只动本键）。 */
export const MAIN_THREAD = '_main'

/** 遍历 item 链的硬上限（防坏数据成环）。 */
export const MAX_CHAIN = 10000

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asCount(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
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

/**
 * 一条按命令名解析的 eval 计划条目（H18：宿主按命令声明解析入口）。
 * `inject` = 宿主在执行期把投影片段按声明路径并入 args（键 → 投影路径）；续跑 eval 用它拿投影。
 */
export function evalDirective(command: string, args: Json, inject?: Rec): Json {
  const directive: Rec = { kind: 'eval', command, args }
  if (inject !== undefined) directive['inject'] = inject
  return directive
}

/** 组装最终计划值：一条 batch + 一条 extern。 */
export function planOf(ops: Json[], payload: Json): Json {
  return { $directives: [batchDirective(ops), externDirective(payload)] }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 结构化失败值（`{ok:false, error:{code, message}}`）。 */
export function failure(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

// ── 投影切片（`ids`）→ 输入槽 / 审批队列 ─────────────────────────────────────

/** `ids.input.body`；缺失 / 非法回 null。 */
export function inputBodyOf(ids: Json): Rec | null {
  if (!isRecord(ids)) return null
  const input = ids['input']
  if (!isRecord(input) || !isRecord(input['body'])) return null
  return input['body']
}

/** 本线程槽体：`body.slots[threadKey]`；缺失 / 非法回 null。 */
export function slotOf(inputBody: Json, threadKey: string): Rec | null {
  if (!isRecord(inputBody) || !isRecord(inputBody['slots'])) return null
  const slot = (inputBody['slots'] as Rec)[threadKey]
  return isRecord(slot) ? slot : null
}

/**
 * 清槽：per-thread 键控——只把本线程键置 `{kind:'idle'}`，其余键原样保留。
 * 返回**新对象**，不改入参（入参是轮首投影的整份 body）。
 */
export function clearSlotsBody(inputBody: Rec, threadKey: string): Rec {
  const slots = isRecord(inputBody['slots']) ? (inputBody['slots'] as Rec) : {}
  return { ...inputBody, slots: { ...slots, [threadKey]: { kind: 'idle' } } }
}

/** `ids.approval.body`（队列 body）；缺失 / 非法回落空队列。 */
export function queueOf(ids: Json): Rec {
  if (isRecord(ids)) {
    const approval = ids['approval']
    if (isRecord(approval) && isRecord(approval['body'])) return approval['body']
  }
  return { version: 1, tail: null, count: 0 }
}

/** `ids.approval.refs`（item 引用闭包）；缺失 / 非法返回空表。 */
export function refsOf(ids: Json): Rec {
  if (isRecord(ids)) {
    const approval = ids['approval']
    if (isRecord(approval) && isRecord(approval['refs'])) return approval['refs']
  }
  return {}
}

/** def 引用 / 裸哈希 → 哈希；形态非法回 null。 */
function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return /^[0-9a-f]{64}$/.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null
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

/** 槽 verdict 词汇（写死 `accept` / `deny`）；其它值回 null。 */
export function normalizeVerdict(value: Json | undefined): string | null {
  const verdict = asString(value)
  return verdict === 'accept' || verdict === 'deny' ? verdict : null
}

/** 待裁决项（`pending`），新版本在前（与 #32 `decide_all` 的取项口径一致）。 */
export function pendingItems(items: Rec[]): Rec[] {
  return items.filter((item) => statusOf(item) === 'pending')
}

/**
 * 拼续跑计划条目：按 item 的 `resume` 游标逐项产 `{kind:'eval', command:'chat.resume', args, inject}`。
 * `cursor` 不透明透传（由 #32 item 携带）；`thread` 取 item.thread，缺省 `_main`；`payload` = 裁决；
 * `inject: {ids: ['ids']}` 声明由**宿主在执行期**把投影切片注入 args——续跑不再自带整份投影。
 * 无 `resume` / 无 `cursor` 的项跳过（不伪造游标）。
 */
export function resumeDirectives(items: Rec[], verdict: string): Json[] {
  const out: Json[] = []
  for (const item of items) {
    const resume = isRecord(item['resume']) ? item['resume'] : null
    const resumeArgs = resume !== null && isRecord(resume['args']) ? resume['args'] : null
    if (resumeArgs === null || !Object.hasOwn(resumeArgs, 'cursor')) continue
    const cursor = resumeArgs['cursor']
    if (cursor === null || cursor === undefined) continue
    const thread = asString(item['thread']) ?? asString(resumeArgs['thread']) ?? MAIN_THREAD
    out.push(
      evalDirective('chat.resume', { cursor, thread, payload: { verdict } }, { ids: ['ids'] }),
    )
  }
  return out
}

/** 失败收口：清本线程槽（若给了 body）+ 结构化 extern，不产业务写。 */
export function clearReject(inputBody: Rec | null, threadKey: string, reason: string): Json {
  if (inputBody === null) return externOnly(failure(reason, reason))
  return planOf([putOp(clearSlotsBody(inputBody, threadKey)), addGenOp('input', 0)], failure(reason, reason))
}

/** 取计划值里的 `$directives`；非计划回 null。 */
export function directivesOf(value: Json): Json[] | null {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return null
  return value['$directives']
}

/** 收集各 item 的 `shadow` def body（`refs` 闭包里可达者），供 UI 解析影子指标。 */
export function shadowRefsOf(items: Rec[], refs: Rec): Rec {
  const out: Rec = {}
  for (const item of items) {
    const shadow = isRecord(item['shadow']) ? item['shadow'] : null
    if (shadow === null) continue
    const hash = asString(shadow['def'])
    if (hash === null) continue
    const body = refs[hash]
    if (isRecord(body)) out[hash] = body
  }
  return out
}

/** 把额外字段并入计划值最后一条 extern 载荷；非计划 / 无 extern 原样返回。 */
export function withExternPayload(value: Json, extra: Rec): Json {
  const directives = directivesOf(value)
  if (directives === null) return value
  for (let index = directives.length - 1; index >= 0; index--) {
    const item = directives[index]
    if (isRecord(item) && item['kind'] === 'extern' && isRecord(item['payload'])) {
      const next = directives.slice()
      next[index] = { ...item, payload: { ...(item['payload'] as Rec), ...extra } }
      return { $directives: next }
    }
  }
  return value
}

export { isRecord }
