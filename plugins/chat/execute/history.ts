// 展示历史还原与切片（纯函数）：从投影 `session.body` + `refs` 沿 `prev` 从链头逆序取回，
// 按 `{conversation, before, limit}` 切出展示窗口。不触发 eff、不写链、不经组装视图。
// `next_before` 恒 null（投影 refs 全量返回，客户端可在 refs 上继续翻页取全量）。

import { asString, isRecord, positiveInt } from './plan.ts'
import { conversationsOf, findConversation, headHashOf } from './assemble.ts'
import type { Json, Rec } from './types.ts'

/** 链上一则消息：哈希 + 消息 def body。 */
export interface ChainEntry {
  hash: string
  body: Rec
}

/** 展示窗口查询（args 可选）。 */
export interface HistoryQuery {
  conversation: string | null
  before: string | null
  limit: number | null
}

/** 从 args 解析查询窗口：`conversation` / `before` 取非空字符串，`limit` 取正整数。 */
export function parseHistoryQuery(args: Json): HistoryQuery {
  const record = isRecord(args) ? args : {}
  return {
    conversation: asString(record['conversation']),
    before: asString(record['before']),
    limit: positiveInt(record['limit']),
  }
}

/** 选会话：显式 id → current → 首条；都没有回 null。 */
export function pickConversation(session: Rec, id: string | null): Rec | null {
  const list = conversationsOf(session)
  const current = asString(session['current'])
  if (id !== null) {
    const found = findConversation(session, id)
    if (found !== null) return found
  }
  if (current !== null) {
    const found = findConversation(session, current)
    if (found !== null) return found
  }
  const first = list[0]
  return isRecord(first) ? first : null
}

/** 沿 `prev` 从链头逆序还原（新 → 旧）；防环（visited 去重）。 */
export function restoreChain(refs: Rec, conversation: Rec | null): ChainEntry[] {
  const chain: ChainEntry[] = []
  const seen = new Set<string>()
  let cursor = headHashOf(conversation)
  while (cursor !== null && !seen.has(cursor) && isRecord(refs[cursor])) {
    seen.add(cursor)
    const body = refs[cursor] as Rec
    chain.push({ hash: cursor, body })
    const prev = body['prev']
    cursor = isRecord(prev) && typeof prev['def'] === 'string' ? (prev['def'] as string) : null
  }
  return chain
}

/**
 * 切片：链为新 → 旧；`before` 命中的那则**不含**（从它更旧处起），再取 `limit` 条。
 * `before` 可为消息 def 哈希或消息 `id`。`limit` 缺省 = 不截断（返回全链窗口）。
 */
export function sliceChain(chain: ChainEntry[], before: string | null, limit: number | null): ChainEntry[] {
  let start = 0
  if (before !== null) {
    const index = chain.findIndex((entry) => entry.hash === before || entry.body['id'] === before)
    start = index >= 0 ? index + 1 : 0
  }
  return limit !== null ? chain.slice(start, start + limit) : chain.slice(start)
}

/**
 * `chat.history` 结果：窗口（新 → 旧）+ 会话 id + 全量 body / refs。
 * body / refs 随窗口一并返回，供 #16 会话列表与 #18 客户端还原展示序（展示真源 = #11）。
 */
export function buildHistory(sessionBody: Rec, refs: Rec, query: HistoryQuery): Rec {
  const conversation = pickConversation(sessionBody, query.conversation)
  const chain = restoreChain(refs, conversation)
  const messages = sliceChain(chain, query.before, query.limit)
  return {
    conversation: conversation !== null ? asString(conversation['id']) : null,
    before: query.before,
    limit: query.limit,
    messages: messages as unknown as Json,
    next_before: null,
    body: sessionBody,
    refs,
  }
}
