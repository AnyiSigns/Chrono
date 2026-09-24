// 抓取出口：把抓取意图映射为 fetcher 参数，经隔离执行跑，再解析响应。
// 隔离执行按 caps.net 四档钳制，越档回 net_denied——本层原样透传，不改写。

import { execBudgetMs, execCaps } from './caps.ts'
import { buildFetcherCommand, parseFetcherStdout } from './fetcher.ts'
import { REVERSE_TIMEOUT_MARGIN_MS } from './reverse.ts'
import { robotsAllows } from './robots.ts'
import { isRec } from './types.ts'
import { isPrivateHost, originOf, parseHttpUrl } from './url.ts'
import type { Json, Rec } from './types.ts'
import type { FetchSpec } from './fetcher.ts'
import type { ToolContext } from './context.ts'

const MAX_ROBOTS_BYTES = 64 * 1024

export type FetchOutcome =
  | {
      ok: true
      status: number
      contentType: string
      url: string
      bytes: Buffer
      truncated: boolean
    }
  | { ok: false; code: string; message: string; status?: number }

export interface FetchOptions {
  /** 允许的 HTTP 状态；缺省 2xx / 3xx 视为成功，4xx / 5xx 回 http_status。 */
  okStatus?: (status: number) => boolean
}

function stringOf(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 组装隔离执行的 bag：命令 + 参数 + caps + 调用方透传的档位 / 执行根 / grant。
 * `budgetMs` 由调用方按 `execBudgetMs` 算出并同时用于反向等待，保证二者同源。
 */
export function makeExecBag(ctx: ToolContext, spec: FetchSpec, net: string, budgetMs: number): Rec {
  const { cmd, args } = buildFetcherCommand(ctx.config.fetcher_cmd, spec)
  const bag: Rec = { cmd, args, caps: execCaps(ctx.caps, net, ctx.config.output_max, budgetMs) }
  if (ctx.tier !== undefined) bag['tier'] = ctx.tier
  if (ctx.workspaceRoot !== undefined) bag['workspace_root'] = ctx.workspaceRoot
  if (ctx.sandboxTiers !== undefined) bag['sandbox_tiers'] = ctx.sandboxTiers
  if (ctx.grant !== undefined) bag['grant'] = ctx.grant
  return bag
}

/** 执行一次抓取并解析 fetcher 输出；网络 / 传输失败回结构化码。 */
export async function fetchUrl(
  ctx: ToolContext,
  spec: FetchSpec,
  net: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  // 执行预算与反向等待同源：取 spec 抓取超时与 caps.timeout_ms 的较大者，再 clamp 在宿主预算内。
  const budgetMs = execBudgetMs(ctx.caps, spec.timeoutMs)
  const outcome = await ctx.backend.exec(
    makeExecBag(ctx, spec, net, budgetMs),
    ctx.callId,
    budgetMs + REVERSE_TIMEOUT_MARGIN_MS,
  )
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message }
  if (!isRec(outcome.value)) {
    return { ok: false, code: 'fetch_failed', message: 'exec returned a non-object value' }
  }
  const execCode = outcome.value['code']
  if (typeof execCode === 'string' && execCode.length > 0 && execCode !== 'null') {
    const code = execCode === 'timeout' ? 'tool_timeout' : 'fetch_failed'
    return { ok: false, code, message: `sandbox exec ${execCode}` }
  }
  const exitCode = outcome.value['exit_code']
  if (typeof exitCode === 'number' && exitCode !== 0) {
    const stderr = stringOf(outcome.value['stderr']).trim()
    return { ok: false, code: 'fetch_failed', message: stderr.length > 0 ? stderr : `fetcher exit ${exitCode}` }
  }
  const parsed = parseFetcherStdout(stringOf(outcome.value['stdout']))
  if (parsed === null) {
    return { ok: false, code: 'fetch_failed', message: 'fetcher output missing metadata' }
  }
  const okStatus = options.okStatus ?? ((status: number) => status < 400)
  if (!okStatus(parsed.status)) {
    return { ok: false, code: 'http_status', message: `HTTP ${parsed.status}`, status: parsed.status }
  }
  const finalUrl = parsed.url.length > 0 ? parsed.url : spec.url
  if (ctx.config.block_private_hosts) {
    const finalHost = parseHttpUrl(finalUrl)?.hostname
    if (finalHost !== undefined && isPrivateHost(finalHost)) {
      return { ok: false, code: 'bad_url', message: `redirected to private host: ${finalHost}` }
    }
  }
  // sandbox 对 stdout 施加 output_max 截断：fetcher 元数据的 truncated 只反映自身 --max-size，
  // 必须合并 exec 的 truncated，否则被截断的 base64 体会被当成完整响应。
  const execTruncated = outcome.value['truncated'] === true
  return {
    ok: true,
    status: parsed.status,
    contentType: parsed.contentType,
    url: finalUrl,
    bytes: parsed.bytes,
    truncated: parsed.truncated || execTruncated,
  }
}

/**
 * 抓取礼貌检查：按 origin 取 robots.txt 并判定目标路径；同一次调用内按 origin 缓存。
 * 取不到 robots.txt（传输失败）视为放行，避免整批检索被一次失败拖垮。
 */
export async function robotsAllowsUrl(
  ctx: ToolContext,
  url: string,
  timeoutMs: number,
  net: string,
  cache: Map<string, string | null>,
): Promise<boolean> {
  const origin = originOf(url)
  let text = cache.get(origin)
  if (text === undefined) {
    const spec: FetchSpec = {
      url: `${origin}/robots.txt`,
      method: 'GET',
      headers: { 'User-Agent': ctx.config.user_agent },
      timeoutMs,
      maxSize: MAX_ROBOTS_BYTES,
      maxRedirs: ctx.config.redirect_max,
    }
    const outcome = await fetchUrl(ctx, spec, net, {
      okStatus: (status) => status < 400 || status === 404,
    })
    text = outcome.ok ? outcome.bytes.toString('utf8') : null
    cache.set(origin, text)
  }
  if (text === null) return true
  const parsed = new URL(url)
  return robotsAllows(text, ctx.config.user_agent, `${parsed.pathname}${parsed.search}`)
}
