// `invoke`：把 `webbrowser` 的 action 分派到会话内引擎动作，结果形状照工具端口契约。
// 会话状态住 SessionManager（③ 进程内）；截图字节经反向调用 `host.asset.put` 存资产、回引用。
// `caps.net` 声明级钳制在本插件内完成，并向 sandbox 咨询强制面可用性（反向 `port.call`）。

import { TOOL_NAME } from './describe.ts'
import { BrowserUnsupportedError } from './engine/types.ts'
import { assertNetAllowed, sandboxNetEnforcement } from './net.ts'
import { BadArgsError, ERROR_CODES, ToolError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'
import type { PortLink } from './link.ts'
import type { SessionManager } from './sessions.ts'

/** invoke 依赖：会话表 + 反向调用通道（生产走 stdio，单测注入假 link）。 */
export interface InvokeContext {
  sessions: SessionManager
  link: PortLink
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(args: Rec, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new ToolError('bad_args', `${key} required`)
  return value
}

function optionalString(args: Rec, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalBoolean(args: Rec, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

function optionalInt(args: Rec, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function viewportOf(args: Rec): { width: number; height: number } | undefined {
  const raw = args['viewport']
  if (!isRecord(raw)) return undefined
  const width = raw['width']
  const height = raw['height']
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    throw new ToolError('bad_args', 'viewport requires positive width and height')
  }
  return { width, height }
}

function errorShape(err: unknown): Rec {
  if (err instanceof ToolError) return { code: err.code, message: err.message }
  if (err instanceof BrowserUnsupportedError) return { code: 'browser_unsupported', message: err.message }
  if (err instanceof BadArgsError) return { code: 'bad_args', message: err.message }
  return { code: 'tool_failed', message: (err as Error).message ?? 'unknown error' }
}

/** 声明级 net 钳制 + 咨询 sandbox 强制面；任何错误原样透传（fail-closed）。 */
async function guardNet(
  ctx: InvokeContext,
  tier: string | null,
  caps: Json | undefined,
  sandboxTiers: Json | undefined,
  callId: string | null,
  grant: Json | undefined,
): Promise<void> {
  // 一次性 net 放宽（#33 approvalGrant 签发）：call_id 匹配且 net 范围覆盖时放行本次。
  const grantNet =
    isRecord(grant) && (callId === null || grant['call_id'] === callId)
      ? parseNetScope(grant['net'])
      : null
  assertNetAllowed(tier, caps, sandboxTiers, grantNet)
  // 消费 sandbox 自述：本插件不走 sandbox.exec，net 只能做声明级钳制，故
  // `enforcement.net = "declaration"` 是与本模型一致的强制口径。若 sandbox 自述
  // 明确「不强制 net」（none），则无任何 net 强制基础，fail-closed 拒绝；
  // 自述缺失 / 未知（老 sandbox）以本插件声明级判定为准，不静默吞掉错误。
  const capabilities = await ctx.link.call('sandbox', 'capabilities', {}, callId)
  if (sandboxNetEnforcement(capabilities) === 'none') {
    throw new ToolError('net_denied', 'sandbox reports no net enforcement')
  }
}

/** grant.net → 规范范围；非 none / limited / all 一律 null（视为未放宽）。 */
function parseNetScope(value: Json | undefined): 'none' | 'limited' | 'all' | null {
  return value === 'none' || value === 'limited' || value === 'all' ? value : null
}

interface CallScope {
  tier: string | null
  caps: Json | undefined
  sandboxTiers: Json | undefined
  grant: Json | undefined
}

/** 取会话（未知 / 过期即 session_not_found），再过 net 钳制。 */
async function withSession(args: Rec, ctx: InvokeContext, env: CallEnv, scope: CallScope, callId: string | null) {
  const id = requiredString(args, 'session')
  const record = ctx.sessions.get(id, env.now)
  await guardNet(ctx, scope.tier, scope.caps, scope.sandboxTiers, callId, scope.grant)
  return record
}

/** 资产面失败码归一到 schema 错误闭集：体积超限归 binary_unsupported，其余未知码归 tool_failed。 */
function assetError(err: unknown): ToolError {
  if (err instanceof ToolError) {
    if (err.code === 'asset_too_large') return new ToolError('binary_unsupported', `asset put failed: ${err.message}`)
    if ((ERROR_CODES as readonly string[]).includes(err.code)) return err
    return new ToolError('tool_failed', `asset put failed: ${err.code}: ${err.message}`)
  }
  return new ToolError('tool_failed', `asset put failed: ${(err as Error).message ?? 'unknown error'}`)
}

async function putAsset(link: PortLink, mime: string, bytes: Buffer, callId: string | null): Promise<Json> {
  let value: Json
  try {
    value = await link.call('host', 'asset.put', { mime, bytes: bytes.toString('base64') }, callId)
  } catch (err) {
    throw assetError(err)
  }
  const rec = isRecord(value) ? value : {}
  return {
    kind: 'asset',
    sha256: rec['sha256'] ?? null,
    mime: typeof rec['mime'] === 'string' ? rec['mime'] : mime,
    size: typeof rec['size'] === 'number' ? rec['size'] : bytes.length,
  }
}

async function dispatchAction(action: string, args: Rec, ctx: InvokeContext, env: CallEnv, scope: CallScope, callId: string | null): Promise<Json> {
  switch (action) {
    case 'open': {
      await guardNet(ctx, scope.tier, scope.caps, scope.sandboxTiers, callId, scope.grant)
      const session = await ctx.sessions.open(env.run, env.now, viewportOf(args))
      return { session }
    }
    case 'navigate': {
      const record = await withSession(args, ctx, env, scope, callId)
      const url = requiredString(args, 'url')
      if (!/^https?:\/\//i.test(url)) throw new ToolError('navigate_failed', `unsupported url: ${url}`)
      const result = await record.engine.navigate(url, optionalString(args, 'wait_until'))
      ctx.sessions.touch(record.id, env.now)
      return { status: result.status, url: result.url, title: result.title }
    }
    case 'click': {
      const record = await withSession(args, ctx, env, scope, callId)
      await record.engine.click(requiredString(args, 'selector'))
      ctx.sessions.touch(record.id, env.now)
      return { ok: true }
    }
    case 'type': {
      const record = await withSession(args, ctx, env, scope, callId)
      await record.engine.type(requiredString(args, 'selector'), requiredString(args, 'text'), optionalBoolean(args, 'submit'))
      ctx.sessions.touch(record.id, env.now)
      return { ok: true }
    }
    case 'press': {
      const record = await withSession(args, ctx, env, scope, callId)
      await record.engine.press(requiredString(args, 'key'))
      ctx.sessions.touch(record.id, env.now)
      return { ok: true }
    }
    case 'wait_for': {
      const selector = optionalString(args, 'selector')
      const ms = optionalInt(args, 'ms')
      if (selector === undefined && ms === undefined) throw new ToolError('bad_args', 'wait_for requires selector or ms')
      const record = await withSession(args, ctx, env, scope, callId)
      await record.engine.waitFor(selector, ms)
      ctx.sessions.touch(record.id, env.now)
      return { ok: true }
    }
    case 'extract': {
      const record = await withSession(args, ctx, env, scope, callId)
      const attr = optionalString(args, 'attr')
      const result = await record.engine.extract(optionalString(args, 'selector'), attr)
      ctx.sessions.touch(record.id, env.now)
      return attr === undefined ? { text: result.text ?? '' } : { value: result.value ?? '' }
    }
    case 'screenshot': {
      const record = await withSession(args, ctx, env, scope, callId)
      const format = optionalString(args, 'format')
      const shot = await record.engine.screenshot(optionalBoolean(args, 'full_page') ?? false, format)
      ctx.sessions.touch(record.id, env.now)
      return { asset: await putAsset(ctx.link, shot.mime, shot.bytes, callId) }
    }
    case 'close': {
      const id = requiredString(args, 'session')
      const closed = await ctx.sessions.close(id, env.now)
      return { closed }
    }
    default:
      throw new ToolError('bad_args', `unknown action ${action}`)
  }
}

/** invoke 入口：成功 `{ok:true, result}`，失败 `{ok:false, error:{code, message}}`。 */
export async function invoke(bag: Json, ctx: InvokeContext, env: CallEnv, callId: string | null = null): Promise<Json> {
  try {
    if (!isRecord(bag)) throw new ToolError('bad_args', 'invoke bag must be an object')
    if (bag['tool'] !== TOOL_NAME) throw new ToolError('unknown_tool', `unknown tool ${String(bag['tool'])}`)
    const args = bag['args']
    if (!isRecord(args)) throw new ToolError('bad_args', 'invoke args must be an object')
    const action = requiredString(args, 'action')
    const scope: CallScope = {
      tier: typeof bag['tier'] === 'string' ? bag['tier'] : null,
      caps: bag['caps'],
      sandboxTiers: bag['sandbox_tiers'],
      grant: bag['grant'],
    }
    return { ok: true, result: await dispatchAction(action, args, ctx, env, scope, callId) }
  } catch (err) {
    return { ok: false, error: errorShape(err) }
  }
}
