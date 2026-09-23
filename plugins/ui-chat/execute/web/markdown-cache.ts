// 流式 markdown 增量渲染缓存（纯函数）：把文本按「不在围栏代码块内的空白行」切成安全块边界，
// 已完成前缀只解析 + 消毒一次并缓存，只有尾部未完成块随每帧重解析。
//
// 等价性：本仓 markdown 渲染器的所有块级构造（段落 / 列表 / 引用 / 围栏）都在空白行处收束，
// 故「空白行边界处切分后分别渲染再拼接」与「整段渲染」结果一致；消毒按标签上下文无关，
// 拼接同理安全。文本收缩 / 换内容（reset、换消息）时前缀不匹配即整体重置。

import { renderMarkdown } from './markdown.ts'
import { sanitizeHtml } from './sanitize.ts'

export interface MarkdownCache {
  /** 已完成前缀的原文。 */
  prefix: string
  /** 已完成前缀的消毒后 HTML。 */
  html: string
}

/** 空缓存。 */
export function createMarkdownCache(): MarkdownCache {
  return { prefix: '', html: '' }
}

const FENCE_RE = /^\s*```/

/**
 * 最后一条「不在围栏代码块内的空白行」之后的位置（含该空白行的换行）；无则 -1。
 * 返回的位置即为可安全切分的前缀右端。
 */
export function safeBoundary(text: string): number {
  const source = String(text ?? '')
  let boundary = -1
  let fenceOpen = false
  let lineStart = 0
  for (let i = 0; i <= source.length; i += 1) {
    if (i === source.length || source[i] === '\n') {
      const line = source.slice(lineStart, i)
      if (FENCE_RE.test(line)) fenceOpen = !fenceOpen
      else if (!fenceOpen && line.trim() === '' && i < source.length) boundary = i + 1
      lineStart = i + 1
    }
  }
  return boundary
}

/**
 * 增量渲染：返回本帧 HTML 与新缓存（不修改入参）。
 * 前缀失配（换消息 / reset）时整体重置后重新累积。
 */
export function renderMarkdownIncremental(
  text: unknown,
  cache: MarkdownCache,
): { html: string; cache: MarkdownCache } {
  const source = String(text ?? '')
  let base = source.startsWith(cache.prefix) ? cache : createMarkdownCache()
  const boundary = safeBoundary(source)
  if (boundary > base.prefix.length) {
    const delta = source.slice(base.prefix.length, boundary)
    base = { prefix: source.slice(0, boundary), html: base.html + sanitizeHtml(renderMarkdown(delta)) }
  }
  const tail = source.slice(base.prefix.length)
  return { html: base.html + sanitizeHtml(renderMarkdown(tail)), cache: base }
}
