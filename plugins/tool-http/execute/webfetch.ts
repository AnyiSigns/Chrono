// webfetch：GET 一个 URL → 按 content-type 分流。
// text/html 走正文提取 + markdown / 纯文本；json / text/* 原样；其它二进制经 host.asset.put 存资产。
// 响应体 ≤ output_max；文本超限截断并标记 truncated，二进制超限回 too_large。

import { NET_WEBFETCH } from './caps.ts'
import { fetchUrl, robotsAllowsUrl } from './net.ts'
import { htmlToMarkdown, htmlToText } from './html.ts'
import { isPrivateHost, parseHttpUrl } from './url.ts'
import { fail, isRec, ok } from './types.ts'
import type { FetchSpec } from './fetcher.ts'
import type { Json, Rec, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

function resolveFormat(raw: Json | undefined): 'markdown' | 'text' | 'raw' {
  return raw === 'text' || raw === 'raw' ? raw : 'markdown'
}

function normalizeContentType(raw: string): string {
  const head = raw.split(';')[0] ?? ''
  return head.trim().toLowerCase()
}

function isTextual(contentType: string): boolean {
  if (HTML_TYPES.has(contentType)) return true
  if (contentType.startsWith('text/')) return true
  if (contentType === 'application/json' || contentType.endsWith('+json')) return true
  if (contentType === 'application/xml' || contentType.endsWith('+xml')) return true
  return false
}

function decodeText(bytes: Buffer, rawContentType: string): string {
  const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(rawContentType)?.[1]?.trim().toLowerCase()
  if (charset === 'latin1' || charset === 'iso-8859-1' || charset === 'latin-1') {
    return bytes.toString('latin1')
  }
  return bytes.toString('utf8')
}

function renderText(text: string, contentType: string, format: 'markdown' | 'text' | 'raw'): string {
  if (format === 'raw' || !HTML_TYPES.has(contentType)) return text
  return format === 'text' ? htmlToText(text) : htmlToMarkdown(text)
}

function fetchSpec(url: string, ctx: ToolContext): FetchSpec {
  return {
    url,
    method: 'GET',
    headers: {
      'User-Agent': ctx.config.user_agent,
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    },
    timeoutMs: ctx.config.source_timeout_ms,
    maxSize: ctx.config.output_max,
    maxRedirs: ctx.config.redirect_max,
  }
}

async function storeBinary(
  bytes: Buffer,
  contentType: string,
  status: number,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mime = contentType.length > 0 ? contentType : 'application/octet-stream'
  const outcome = await ctx.backend.assetPut({ mime, bytes: bytes.toString('base64') })
  if (!outcome.ok) {
    return fail('binary_unsupported', outcome.message, { status })
  }
  const asset = isRec(outcome.value) ? (outcome.value as Rec) : {}
  return ok({
    url: '',
    status,
    content_type: contentType,
    content: '',
    truncated: false,
    asset: asset as Json,
  })
}

/** webfetch 入口。 */
export async function webfetch(args: Json, ctx: ToolContext): Promise<ToolResult> {
  const bag = isRec(args) ? args : {}
  const rawUrl = bag['url']
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return fail('bad_args', 'url must be a non-empty string')
  }
  const url = parseHttpUrl(rawUrl)
  if (url === null) return fail('bad_url', `not an http(s) url: ${rawUrl}`)
  if (ctx.config.block_private_hosts && isPrivateHost(url.hostname)) {
    return fail('bad_url', `private host is blocked: ${url.hostname}`)
  }
  const format = resolveFormat(bag['format'])
  if (ctx.config.obey_robots) {
    const allowed = await robotsAllowsUrl(ctx, url.toString(), ctx.config.source_timeout_ms, NET_WEBFETCH, new Map())
    if (!allowed) return fail('robots_disallowed', `robots.txt disallows ${url.toString()}`)
  }
  const outcome = await fetchUrl(ctx, fetchSpec(url.toString(), ctx), NET_WEBFETCH)
  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.status === undefined ? {} : { status: outcome.status })
  }
  // 跟随重定向后的最终落点仍需过 robots：初始 URL 的放行不覆盖最终 URL。
  if (ctx.config.obey_robots && outcome.url !== url.toString()) {
    const allowed = await robotsAllowsUrl(ctx, outcome.url, ctx.config.source_timeout_ms, NET_WEBFETCH, new Map())
    if (!allowed) return fail('robots_disallowed', `robots.txt disallows ${outcome.url}`)
  }
  const contentType = normalizeContentType(outcome.contentType)
  const oversize = outcome.bytes.length > ctx.config.output_max
  if (!isTextual(contentType)) {
    if (oversize || outcome.truncated) {
      return fail('too_large', 'binary body exceeds output_max', { status: outcome.status })
    }
    const stored = await storeBinary(outcome.bytes, contentType, outcome.status, ctx)
    if (stored.ok) stored.result['url'] = outcome.url
    return stored
  }
  const bytes = oversize ? outcome.bytes.subarray(0, ctx.config.output_max) : outcome.bytes
  const content = renderText(decodeText(bytes, outcome.contentType), contentType, format)
  return ok({
    url: outcome.url,
    status: outcome.status,
    content_type: contentType,
    content,
    truncated: outcome.truncated || oversize,
  })
}
