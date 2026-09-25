// 共享纯函数：续跑计划条目拼接、影子引用收集、extern 载荷合并。服务不读投影、不构造世界写计划——
// 队列由 `approval` 自有存储持有；本插件只按裁决结果拼 `chat.resume` 续跑条目。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export type Rec = { [key: string]: Json }

/** 缺省线程键。 */
export const MAIN_THREAD = '_main'

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 一条 `extern` 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 无业务写时的计划值：只有一条 extern。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/**
 * 一条按命令名解析的 eval 计划条目：宿主按命令声明解析入口。
 * `inject` = 宿主在执行期把投影片段按声明路径并入 args（键 → 投影路径）；续跑 eval 用它拿投影。
 */
export function evalDirective(command: string, args: Json, inject?: Rec): Json {
  const directive: Rec = { kind: 'eval', command, args }
  if (inject !== undefined) directive['inject'] = inject
  return directive
}

/** 结构化失败值（`{ok:false, error:{code, message}}`）。 */
export function failure(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 槽 verdict 词汇（写死 `accept` / `deny`）；其它值回 null。 */
export function normalizeVerdict(value: Json | undefined): string | null {
  const verdict = asString(value)
  return verdict === 'accept' || verdict === 'deny' ? verdict : null
}

/** 取计划值里的 `$directives`；非计划回 null。 */
export function directivesOf(value: Json): Json[] | null {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return null
  return value['$directives']
}

/** 取计划值最后一条 `extern` 的载荷；无回 null。 */
export function externPayloadOf(value: Json): Rec | null {
  const directives = directivesOf(value)
  if (directives === null) return null
  for (let index = directives.length - 1; index >= 0; index--) {
    const item = directives[index]
    if (isRecord(item) && item['kind'] === 'extern' && isRecord(item['payload'])) return item['payload'] as Rec
  }
  return null
}

/**
 * 拼续跑计划条目：按 `approval` 回执里的 `resumes`（`{id, thread, resume}`）逐项产
 * `{kind:'eval', command:'chat.resume', args, inject}`。`cursor` 不透明透传；`payload` = 裁决；
 * `inject: {ids: ['ids']}` 声明由**宿主在执行期**把投影切片注入 args——续跑不再自带整份投影。
 * 无 `resume` / 无 `cursor` 的项跳过（不伪造游标）。
 */
export function resumeDirectives(targets: Rec[], verdict: string): Json[] {
  const out: Json[] = []
  for (const target of targets) {
    const resume = isRecord(target['resume']) ? target['resume'] : null
    const resumeArgs = resume !== null && isRecord(resume['args']) ? resume['args'] : null
    if (resumeArgs === null || !Object.hasOwn(resumeArgs, 'cursor')) continue
    const cursor = resumeArgs['cursor']
    if (cursor === null || cursor === undefined) continue
    const thread = asString(target['thread']) ?? asString(resumeArgs['thread']) ?? MAIN_THREAD
    out.push(evalDirective('chat.resume', { cursor, thread, payload: { verdict } }, { ids: ['ids'] }))
  }
  return out
}

/** 收集各 item 的 `shadow` def body（跨身份 `refs` 闭包里可达者），供 UI 解析影子指标。 */
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

/**
 * 汇总投影切片里各身份的 `refs` 闭包（队列已出世界，影子指标 def 仍可达于 `evolution` / `loop-policy` 等
 * 判定平面身份；UI 只读展示，不改变判定）。
 */
export function allRefsOf(ids: Json): Rec {
  const out: Rec = {}
  if (!isRecord(ids)) return out
  for (const entry of Object.values(ids)) {
    if (!isRecord(entry)) continue
    const refs = entry['refs']
    if (!isRecord(refs)) continue
    for (const [hash, body] of Object.entries(refs)) out[hash] = body
  }
  return out
}

/** 从计划值取队列项（`approval.list` 回执 extern 载荷的 `items`）。 */
export function itemsOf(value: Json): Rec[] {
  const payload = externPayloadOf(value)
  const items = payload === null ? null : payload['items']
  if (!Array.isArray(items)) return []
  return items.filter(isRecord)
}

export { isRecord }
