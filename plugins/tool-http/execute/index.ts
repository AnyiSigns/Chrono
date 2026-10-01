// 本地索引的调用面：read-through 查询与写回（含正文），websearch / webresearch / webfetch 共用。
// 索引是可选增强：无 search-index 成员 / 后端不可用 / 失败一律静默降级，不影响检索与抓取。

import { isRec } from './types.ts'
import type { Json } from './types.ts'
import type { ToolContext } from './context.ts'
import type { RawResult } from './sources.ts'

/** 写回索引的单条文档；`body` 为正文（写回前按 INDEX_BODY_MAX 截断）。 */
export interface IndexDocument {
  url: string
  title: string
  snippet: string
  source: string
  body: string
}

/** 写回正文的字符上限：约束反向帧与索引体积，超出截断。 */
export const INDEX_BODY_MAX = 20000

/** 本地索引是否可用（配置开 + 后端有 indexSearch）。 */
export function indexEnabled(ctx: ToolContext): boolean {
  return ctx.config.index_enabled === true && typeof ctx.backend.indexSearch === 'function'
}

/** 本地索引检索（read-through）：把命中折叠为 RawResult；无后端 / 失败 / 畸形一律回空。 */
export async function queryIndex(query: string, limit: number, ctx: ToolContext): Promise<RawResult[]> {
  if (typeof ctx.backend.indexSearch !== 'function') return []
  let outcome: Awaited<ReturnType<ToolContext['backend']['indexSearch']>>
  try {
    outcome = await ctx.backend.indexSearch({ query, limit }, ctx.callId)
  } catch {
    return []
  }
  if (!outcome.ok || !isRec(outcome.value) || !Array.isArray(outcome.value['results'])) return []
  const results: RawResult[] = []
  for (const item of outcome.value['results']) {
    if (!isRec(item)) continue
    const url = typeof item['url'] === 'string' ? item['url'] : ''
    if (url.length === 0) continue
    results.push({
      title: typeof item['title'] === 'string' ? item['title'] : url,
      url,
      snippet: typeof item['snippet'] === 'string' ? item['snippet'] : '',
    })
  }
  return results
}

/** 写回一批文档（best-effort）：索引关闭 / 无后端 / 失败都不影响调用方。 */
export async function putIndex(documents: IndexDocument[], ctx: ToolContext): Promise<void> {
  if (ctx.config.index_enabled !== true || documents.length === 0) return
  if (typeof ctx.backend.indexPut !== 'function') return
  const bounded = documents
    .filter((doc) => doc.url.length > 0)
    .map((doc) => ({
      ...doc,
      body: doc.body.length > INDEX_BODY_MAX ? doc.body.slice(0, INDEX_BODY_MAX) : doc.body,
    }))
  if (bounded.length === 0) return
  try {
    await ctx.backend.indexPut({ documents: bounded } as unknown as Json, ctx.callId)
  } catch {
    // 索引写回失败不影响调用方
  }
}
