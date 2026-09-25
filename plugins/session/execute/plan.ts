// 共享纯函数：会话记录的形状归一、时间格式化与摘要。服务不读投影、不构造世界写计划。

import type { CallEnv, Json } from './types.ts'

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

/** 会话列表（数组）；缺失 / 非数组返回空数组。 */
export function conversationsOf(session: Rec): Json[] {
  const list = session['conversations']
  return Array.isArray(list) ? list : []
}

/** 线程键：args.thread_id 非空字符串，否则 `_main`。 */
export function threadKeyOf(args: Rec): string {
  return asString(args['thread_id']) ?? '_main'
}

/** 一条消息 body。`prev` 为 null / 字面 `{def:id}`。 */
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
 */
export function conversationEvent(env: CallEnv, conversationId: string | null): Rec {
  return { run: env.run, thread: conversationId, conversation: conversationId }
}
