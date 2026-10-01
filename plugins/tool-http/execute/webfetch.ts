// webfetch：GET 一个 URL → 按 content-type 分流。
// text/html 走正文提取 + markdown / 纯文本；json / text/* 原样；其它二进制经 host.asset.put 存资产。
// 响应体 ≤ output_max；文本超限截断并标记 truncated，二进制超限回 too_large。

import { NET_WEBFETCH } from './caps.ts'
import { decodeText, HTML_TYPES, isTextual, normalizeContentType, renderText } from './content.ts'
import { byteLength, fetchDigest } from './digest.ts'
import { extractTitle } from './html.ts'
import { putIndex } from './index.ts'
import { fetchUrl, robotsAllowsUrl } from './net.ts'
import { DEFAULT_CALL_TIMEOUT_MS, REVERSE_TIMEOUT_MARGIN_MS } from './reverse.ts'
import { isPrivateHost, parseHttpUrl } from './url.ts'
import { fail, isRec, ok } from './types.ts'
import type { FetchSpec } from './fetcher.ts'
import type { Json, Rec, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

function resolveFormat(raw: Json | undefined): 'markdown' | 'text' | 'raw' {
  return raw === 'text' || raw === 'raw' ? raw : 'markdown'
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
  // 反向等待加余量：宿主 `host.asset.put` 面回落 30s，等值会让反向等待先于宿主结算。
  const outcome = await ctx.backend.assetPut(
    { mime, bytes: bytes.toString('base64') },
    ctx.callId,
    DEFAULT_CALL_TIMEOUT_MS + REVERSE_TIMEOUT_MARGIN_MS,
  )
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
    const allowed = await robotsAllowsUrl(
      ctx,
      url.toString(),
      ctx.config.source_timeout_ms,
      NET_WEBFETCH,
      new Map(),
    )
    if (!allowed) return fail('robots_disallowed', `robots.txt disallows ${url.toString()}`)
  }
  const outcome = await fetchUrl(ctx, fetchSpec(url.toString(), ctx), NET_WEBFETCH)
  if (!outcome.ok) {
    const extra: Rec = outcome.status === undefined ? {} : { status: outcome.status }
    // 4xx/5xx 里 403 / 429 / 503 常见于 JS 挑战 / 限流：提示改用 webbrowser 渲染。
    if (
      outcome.code === 'http_status' &&
      (outcome.status === 403 || outcome.status === 429 || outcome.status === 503)
    ) {
      extra['render_suggested'] = true
    }
    return fail(outcome.code, outcome.message, extra)
  }
  // 跟随重定向后的最终落点仍需过 robots：初始 URL 的放行不覆盖最终 URL。
  if (ctx.config.obey_robots && outcome.url !== url.toString()) {
    const allowed = await robotsAllowsUrl(
      ctx,
      outcome.url,
      ctx.config.source_timeout_ms,
      NET_WEBFETCH,
      new Map(),
    )
    if (!allowed) return fail('robots_disallowed', `robots.txt disallows ${outcome.url}`)
  }
  const contentType = normalizeContentType(outcome.contentType)
  const oversize = outcome.bytes.length > ctx.config.output_max
  if (!isTextual(contentType)) {
    if (oversize || outcome.truncated) {
      return fail('too_large', 'binary body exceeds output_max', { status: outcome.status })
    }
    const stored = await storeBinary(outcome.bytes, contentType, outcome.status, ctx)
    if (stored.ok) {
      stored.result['url'] = outcome.url
      stored.result['digest'] = fetchDigest(outcome.url, outcome.status, outcome.bytes.length)
    }
    return stored
  }
  const bytes = oversize ? outcome.bytes.subarray(0, ctx.config.output_max) : outcome.bytes
  const rawText = decodeText(bytes, outcome.contentType)
  const content = renderText(rawText, contentType, format)
  // 正文回灌本地索引（best-effort）：抓取结果沉淀成可检索语料。
  await putIndex(
    [
      {
        url: outcome.url,
        title: HTML_TYPES.has(contentType) ? extractTitle(rawText) : '',
        snippet: '',
        source: 'webfetch',
        body: content,
      },
    ],
    ctx,
  )
  const result: Rec = {
    url: outcome.url,
    status: outcome.status,
    content_type: contentType,
    content,
    truncated: outcome.truncated || oversize,
    digest: fetchDigest(outcome.url, outcome.status, byteLength(content)),
  }
  // 抽取到的 HTML 正文过短（多为 JS 渲染页）：提示改用 webbrowser。
  const minChars = ctx.config.render_min_chars ?? 200
  if (HTML_TYPES.has(contentType) && content.trim().length < minChars) {
    result['render_suggested'] = true
  }
  return ok(result)
}
