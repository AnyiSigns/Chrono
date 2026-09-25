// 纯函数判定：逐 call 出 allow / escalate / deny。
// 不发起 eff、不等待、不取时间、不用随机——同输入同输出（可回放）。
// 只做词法预判；realpath 权威在沙箱，两判不一致时由沙箱 fail-closed 拒绝。

import { FAIL_CLOSED_TIER, parseRules } from './rules.ts'
import type { DangerPattern, Rules, TierPolicy } from './rules.ts'
import { BadArgsError } from './types.ts'
import type { Decision, Json, JudgeResult, Rec } from './types.ts'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** net 范围序：none < limited < all（与 sandbox / tool-browser 同口径）。 */
const NET_RANK: Record<string, number> = { none: 0, limited: 1, all: 2 }

function netRank(scope: string): number {
  return NET_RANK[scope] ?? 0
}

/** 规范化 net 范围：只认 none / limited / all，其余视为 none。 */
function netScope(value: Json | undefined): string {
  return value === 'limited' || value === 'all' ? value : 'none'
}

function tierPolicy(rules: Rules, tier: string | null): TierPolicy {
  if (tier !== null && Object.hasOwn(rules.tiers, tier)) return rules.tiers[tier]
  return FAIL_CLOSED_TIER
}

// ── 词法路径（不触盘、不解引用；realpath 权威在沙箱） ─────────────────────────

/** 纯词法归一：统一分隔符、消 `.` / `..`、盘符小写；不触盘。 */
function normalizeLexical(input: string): string {
  const slashed = input.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(slashed)
  const absolute = slashed.startsWith('/') || drive !== null
  const stack: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!absolute) stack.push('..')
      continue
    }
    stack.push(part)
  }
  const body = stack.join('/')
  if (drive !== null) return `${drive[1].toLowerCase()}:/${body}`
  return absolute ? `/${body}` : body
}

/** 相对路径按 root 解析后再归一；绝对路径直接归一。 */
function resolveLexical(root: string, target: string): string {
  const slashed = target.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return normalizeLexical(slashed)
  return normalizeLexical(`${root.replace(/\\/g, '/')}/${slashed}`)
}

function samePath(left: string, right: string): boolean {
  const caseInsensitive =
    process.platform === 'win32' || /^[A-Za-z]:\//.test(left) || /^[A-Za-z]:\//.test(right)
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 词法包含：target 归一后是否落在 root 之内（含 root 本身）。 */
function isInside(root: string, target: string): boolean {
  const rootNorm = normalizeLexical(root)
  const targetNorm = resolveLexical(root, target)
  if (samePath(rootNorm, targetNorm)) return true
  const prefix = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`
  if (targetNorm.length < prefix.length) return false
  return samePath(targetNorm.slice(0, prefix.length), prefix)
}

// ── 规则命中 ───────────────────────────────────────────────────────────────

/** 危险模式搜索文本：工具名 + args 的规范 JSON（小写、空白归一）。 */
function haystack(call: Rec): string {
  const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
  let args = ''
  try {
    args = JSON.stringify(call['args'] ?? null)
  } catch {
    args = ''
  }
  return `${tool} ${args}`.toLowerCase().replace(/\s+/g, ' ')
}

function matchPattern(pattern: DangerPattern, text: string): boolean {
  return pattern.any_of.some((group) => group.every((token) => text.includes(token.toLowerCase())))
}

/** call 里的路径：顶层 path_keys + args 内 arg_path_keys（字符串或字符串数组）。 */
function pathsOf(call: Rec, rules: Rules): string[] {
  const out: string[] = []
  for (const key of rules.workspace.call_path_keys) {
    const value = call[key]
    if (typeof value === 'string' && value.length > 0) out.push(value)
  }
  const args = call['args']
  if (isRecord(args)) {
    for (const key of rules.workspace.arg_path_keys) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) out.push(value)
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.length > 0) out.push(item)
        }
      }
    }
  }
  return out
}

/** 外部 MCP 服务器名：顶层 server 优先，其次 args.server。 */
function serverOf(call: Rec): string | null {
  const direct = call['server']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const args = call['args']
  if (isRecord(args)) {
    const fromArgs = args['server']
    if (typeof fromArgs === 'string' && fromArgs.length > 0) return fromArgs
  }
  return null
}

// ── 单 call 判定 ────────────────────────────────────────────────────────────

/**
 * 判定优先级（先命中先定）：deny（形态 / 禁止 / 白名单）→ 结构写 → 外部 MCP →
 * 危险模式 → 工作区外 → net 越档 → allow。各 escalate 类别按当前档的 tier 策略开关；
 * 关（如 auto 档）即直落 allow。
 */
function judgeCall(
  call: Json,
  index: number,
  rules: Rules,
  tier: TierPolicy,
  workspaceRoot: string | null,
  tierNet: string,
): Decision {
  if (!isRecord(call)) {
    return { index, port: '', tool: '', verdict: 'deny', reason: 'bad_call' }
  }
  const port = typeof call['port'] === 'string' ? call['port'] : ''
  const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
  if (port.length === 0 || tool.length === 0) {
    return { index, port, tool, verdict: 'deny', reason: 'bad_call' }
  }

  for (const entry of rules.deny.calls) {
    if (entry.port === port && entry.tool === tool) {
      return { index, port, tool, verdict: 'deny', reason: 'forbidden_call' }
    }
  }
  if (rules.deny.allowed_ports !== null && !rules.deny.allowed_ports.includes(port)) {
    return { index, port, tool, verdict: 'deny', reason: 'undeclared_capability' }
  }

  for (const entry of rules.structural_writes) {
    if (entry.port === port && entry.tool === tool) {
      if (!tier.structural) return { index, port, tool, verdict: 'allow', reason: 'allowed' }
      return { index, port, tool, verdict: entry.verdict, reason: 'structural_write', rule: `${port}.${tool}` }
    }
  }

  if (port === rules.mcp.port) {
    const server = serverOf(call)
    const trusted = rules.mcp.trusted.some(
      (item) => item.confirmed && item.trusted && item.server === server,
    )
    if (trusted || rules.mcp.default_verdict === 'allow') {
      return { index, port, tool, verdict: 'allow', reason: 'allowed' }
    }
    if (rules.mcp.default_verdict === 'deny') {
      return { index, port, tool, verdict: 'deny', reason: 'mcp_untrusted', rule: server ?? tool }
    }
    if (tier.mcp) {
      return { index, port, tool, verdict: 'escalate', reason: 'mcp_untrusted', rule: server ?? tool }
    }
    return { index, port, tool, verdict: 'allow', reason: 'allowed' }
  }

  const text = haystack(call)
  for (const pattern of rules.danger_patterns) {
    if (matchPattern(pattern, text)) {
      if (!tier.danger) return { index, port, tool, verdict: 'allow', reason: 'allowed' }
      return { index, port, tool, verdict: pattern.verdict, reason: 'dangerous_pattern', rule: pattern.id }
    }
  }

  if (rules.workspace.enabled && tier.outside && workspaceRoot !== null && workspaceRoot.length > 0) {
    for (const path of pathsOf(call, rules)) {
      if (!isInside(workspaceRoot, path)) {
        if (rules.workspace.verdict === 'allow') return { index, port, tool, verdict: 'allow', reason: 'allowed' }
        return { index, port, tool, verdict: rules.workspace.verdict, reason: 'outside_workspace', rule: path }
      }
    }
  }

  // net 越档：调用方（#33 gateBag）把工具声明的 net 与当前档 net 范围随 call / bag 传入，
  // 本插件只做序比较与裁决；真正的强制面在 sandbox / 工具自身（grant 放行见 #33 approvalGrant）。
  if (rules.net.enabled && tier.net) {
    const required = netScope(call['net'])
    if (required !== 'none' && netRank(required) > netRank(tierNet)) {
      if (rules.net.verdict === 'allow') return { index, port, tool, verdict: 'allow', reason: 'allowed' }
      return { index, port, tool, verdict: rules.net.verdict, reason: 'net_outside_tier', rule: required }
    }
  }

  return { index, port, tool, verdict: 'allow', reason: 'allowed' }
}

/** judge(bag)：bag = `{calls, tier?, tier_net?, workspace_root?, guard_rules?}` → 逐 call 判定 + 计数。 */
export function judge(bag: Json): JudgeResult {
  if (!isRecord(bag)) throw new BadArgsError('bag must be an object')
  const rules = parseRules(bag['guard_rules'])
  const rawCalls = bag['calls']
  let calls: Json[]
  if (rawCalls === undefined || rawCalls === null) calls = []
  else if (Array.isArray(rawCalls)) calls = rawCalls
  else throw new BadArgsError('calls must be an array')

  const tier = typeof bag['tier'] === 'string' ? bag['tier'] : null
  const policy = tierPolicy(rules, tier)
  const workspaceRoot = typeof bag['workspace_root'] === 'string' ? bag['workspace_root'] : null
  // 档位 net 范围由调用方算好随 bag 传入；缺失按 none fail-closed（不静默放行越档）。
  const tierNet = netScope(bag['tier_net'])

  const decisions = calls.map((call, index) => judgeCall(call, index, rules, policy, workspaceRoot, tierNet))
  const summary = { allow: 0, escalate: 0, deny: 0 }
  for (const decision of decisions) summary[decision.verdict] += 1
  return { decisions, summary }
}
