// 共享纯函数：字段规范化与计划值构造。服务不读投影、不落账、不构造世界写计划——
// 队列与游标写自有持久存储（`store.ts`），返回的 `$directives` 只含续跑 `eval` 与 `extern`（观测）。

import { asString, isRecord, nowOf } from 'plugin-sdk'
import type { Json, Rec } from 'plugin-sdk'

export { asString, isRecord, nowOf }
export type { Rec }

export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/**
 * 一条按命令名解析入口的 eval 计划条目（宿主 plan 通道）。
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

/** 无业务写时的计划值：只有一条 extern（服务从不构造世界写）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/**
 * 续跑依据：`{command:'chat.resume', args:{cursor, thread}}`。
 * cursor 由调用方（执行游标）随 bag 传入，不透明透传；无 cursor 时 null（本 run 无法续跑）。
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
