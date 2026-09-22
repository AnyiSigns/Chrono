// 计划构造与共享纯函数：只把各节点返回的写计划机械合并为顶层 `$directives`，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}` /
// `{kind:'eval', command, args}`（H18，续跑）；占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import type { Json, Rec } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 数组；否则 null。 */
export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 字符串数组：缺省空数组；含非字符串即剔（不抛）。 */
export function asStringArray(value: Json | undefined): string[] {
  const list = asArray(value)
  if (list === null) return []
  return list.filter((item): item is string => typeof item === 'string')
}

/** 有限数值；否则 null。 */
export function numberField(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 正整数；否则 null。 */
export function positiveInt(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失回落 args.now，绝不自取时钟。 */
export function nowOf(env: { now: number }, args: Rec): number {
  if (typeof env.now === 'number' && Number.isFinite(env.now)) return env.now
  return numberField(args['now']) ?? 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（事件 / trace 用）。 */
export function summaryOf(value: Json, limit = 160): string {
  let text = ''
  if (typeof value === 'string') text = value
  else if (isRecord(value) && typeof value['content'] === 'string') text = value['content']
  else text = JSON.stringify(value) ?? ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/** 单条 add_gen 子操作：payload / sig 指向同批更早的 put（四字段全必填）。 */
export function addGenOp(id: string, index: number, pins: Rec = {}): Json {
  return { op: 'add_gen', args: { id, payload: { $n: index }, sig: { $n: index }, pins } }
}

/** 单条 add_gen 子操作：payload / sig 指向**已在世界**的 def 哈希（采纳阶段跨身份写）。 */
export function addGenRefOp(id: string, hash: string, pins: Rec = {}): Json {
  return { op: 'add_gen', args: { id, payload: { def: hash }, sig: { def: hash }, pins } }
}

/** 一条原子 batch write 计划条目。 */
export function batchDirective(ops: Json[]): Json {
  return { kind: 'write', request: { op: 'batch', args: { ops } } }
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 一条 eval 计划条目（H18：宿主按命令名解析入口）。 */
export function evalDirective(command: string, args: Json): Json {
  return { kind: 'eval', command, args }
}

/** 值里是否带计划通道包装 `$directives`。 */
export function directivesOf(value: Json): Json[] {
  if (isRecord(value) && Array.isArray(value['$directives'])) return value['$directives'] as Json[]
  return []
}

/**
 * 工具结果里冒泡的写计划：`results[].result.$directives`。
 * #27 `tools.dispatch` 只回 results、不冒泡计划（见其 schema `dispatch_result`），
 * 故 question / todo 等提供者把写计划放进工具结果，由 #33 `tool.dispatch` 在此收集并入回合尾计划。
 */
export function nestedDirectivesOf(value: Json): Json[] {
  if (!isRecord(value)) return []
  const results = value['results']
  if (!Array.isArray(results)) return []
  const out: Json[] = []
  for (const item of results) {
    if (!isRecord(item)) continue
    const result = item['result']
    if (isRecord(result) && Array.isArray(result['$directives'])) {
      for (const directive of result['$directives'] as Json[]) out.push(directive)
    }
  }
  return out
}

/** 按段序机械合并各段计划条目：数组拼接，不构造新 JSON 对象。 */
export function mergeDirectives(segments: Json[]): Json[] {
  const merged: Json[] = []
  for (const segment of segments) {
    for (const directive of directivesOf(segment)) merged.push(directive)
  }
  return merged
}

/** 组装最终计划值：写条目 + 一条 extern 摘要。 */
export function planOf(directives: Json[], payload: Json): Json {
  return { $directives: [...directives, externDirective(payload)] }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 值是否为结构化失败（`{ok:false,...}`）。 */
export function isErrorValue(value: Json): boolean {
  return isRecord(value) && value['ok'] === false
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
