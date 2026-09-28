// 工具结果摘要（digest）：随成功结果自带，供上下文老化直接渲染，无需装配器认识工具语义。
// 只放确定、有界的展示字段：不含时间、不含正文全文，同输入恒同输出。

import type { Json, Rec } from './types.ts'

/** UTF-8 字节数（信息性规模字段，不参与上限判断）。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 抓取类结果摘要：最终落点、HTTP 状态码、正文字节数。 */
export function fetchDigest(url: string, status: number, bytes: number): Rec {
  return { url, status, bytes }
}

/** 检索类结果摘要：查询、命中条数、参与合并的源名。 */
export function searchDigest(query: string, hits: number, sources: readonly string[]): Rec {
  return { query, hits, sources: sources as unknown as Json }
}
