// guard 取数侧：词法路径归一 / 危险与白名单模式命中 / 规则解析 / net 范围归一。
// 判定（优先级裁决）住 term（terms.src/guard.json）；本模块只出「事实」与「列表材料化」，
// 不含裁决分支、不读投影、不取时间 / 随机 —— 同输入同输出。

import { netRank, netScope } from 'plugin-sdk'
import { FAIL_CLOSED_TIER, parseRules } from './rules.ts'
import type { Rules, TierPolicy } from './rules.ts'
import { BadArgsError } from './types.ts'
import type { Json, Rec, Verdict } from './types.ts'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * 危险模式词元的边界口径：两侧不得紧邻标识符字符（字母 / 数字 / `_` / `-`）。
 * 裸子串匹配会误命中——`Format-Table` 含 `rm`、`-Recurse` 含 `-r`，于是 `["rm","-r"]`
 * 把「统计代码行数」判成递归删除。加边界后 `-r` 不再命中 `-recurse`、`rm` 不再命中 `format`。
 */
function tokenBoundaryRe(token: string): RegExp {
  const body = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${body}(?![A-Za-z0-9_-])`)
}

function matchPattern(pattern: { any_of: string[][] }, text: string): boolean {
  return pattern.any_of.some((group) =>
    group.every((token) => tokenBoundaryRe(token.toLowerCase()).test(text)),
  )
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

/** 命令文本：tool-shell 的 `args.input`（兼容 `args.command`）。 */
function commandOf(call: Rec): string | null {
  const args = call['args']
  if (!isRecord(args)) return null
  for (const key of ['input', 'command']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * 保守分词：按空白切分、识别单双引号；**不**解析 shell 运算符（`&&` / `|` / `;`）。
 * 故前缀白名单只保证「命令以这些词元开头」，链式命令的安全兜底仍是危险模式（危险模式先于白名单判定）。
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** 前缀白名单命中：port / tool 相同，且命令词元以 `prefix` 开头（大小写不敏感、逐词匹配）。 */
function matchesAllowPattern(
  entry: { port: string; tool: string; prefix: string[] },
  port: string,
  tool: string,
  tokens: string[],
): boolean {
  if (entry.port !== port || entry.tool !== tool) return false
  if (tokens.length < entry.prefix.length) return false
  return entry.prefix.every((token, index) => tokens[index].toLowerCase() === token.toLowerCase())
}

// ── 事实对象 ───────────────────────────────────────────────────────────────

interface CategoryFact {
  matched: boolean
  verdict: Verdict
  rule: string
}

interface CallFact {
  index: number
  port: string
  tool: string
  invalid: boolean
  forbidden: boolean
  portAllowed: boolean
  structural: { matched: boolean; verdict: Verdict; rule: string }
  mcp: { isMcp: boolean; trusted: boolean; rule: string }
  danger: CategoryFact
  allow: CategoryFact
  outside: CategoryFact
  net: CategoryFact
  policy: TierPolicy
  mcpDefault: Verdict
  workspaceVerdict: Verdict
  netVerdict: Verdict
}

function category(verdict: Verdict): CategoryFact {
  return { matched: false, verdict, rule: '' }
}

function invalidFact(index: number, port: string, tool: string, policy: TierPolicy, rules: Rules): CallFact {
  return {
    index,
    port,
    tool,
    invalid: true,
    forbidden: false,
    portAllowed: true,
    structural: { matched: false, verdict: 'escalate', rule: '' },
    mcp: { isMcp: false, trusted: false, rule: '' },
    danger: category('escalate'),
    allow: category('allow'),
    outside: category(rules.workspace.verdict),
    net: category(rules.net.verdict),
    policy,
    mcpDefault: rules.mcp.default_verdict,
    workspaceVerdict: rules.workspace.verdict,
    netVerdict: rules.net.verdict,
  }
}

function factOf(
  call: Json,
  index: number,
  rules: Rules,
  policy: TierPolicy,
  workspaceRoot: string | null,
  tierNet: string,
): CallFact {
  if (!isRecord(call)) {
    return invalidFact(index, '', '', policy, rules)
  }
  const port = typeof call['port'] === 'string' ? call['port'] : ''
  const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
  if (port.length === 0 || tool.length === 0) {
    return invalidFact(index, port, tool, policy, rules)
  }

  const forbidden = rules.deny.calls.some((entry) => entry.port === port && entry.tool === tool)
  const portAllowed =
    rules.deny.allowed_ports === null || rules.deny.allowed_ports.includes(port)

  let structural: CallFact['structural'] = { matched: false, verdict: 'escalate', rule: '' }
  for (const entry of rules.structural_writes) {
    if (entry.port === port && entry.tool === tool) {
      structural = { matched: true, verdict: entry.verdict, rule: `${port}.${tool}` }
      break
    }
  }

  const isMcp = port === rules.mcp.port
  const server = serverOf(call)
  const trusted =
    isMcp && rules.mcp.trusted.some((item) => item.confirmed && item.trusted && item.server === server)
  const mcp = { isMcp, trusted, rule: server ?? tool }

  const text = haystack(call)
  let danger: CategoryFact = category('escalate')
  for (const pattern of rules.danger_patterns) {
    if (matchPattern(pattern, text)) {
      danger = { matched: true, verdict: pattern.verdict, rule: pattern.id }
      break
    }
  }

  let allow: CategoryFact = category('allow')
  const command = commandOf(call)
  if (command !== null) {
    const tokens = tokenizeCommand(command)
    for (const entry of rules.allow_patterns) {
      if (matchesAllowPattern(entry, port, tool, tokens)) {
        allow = { matched: true, verdict: entry.verdict, rule: entry.prefix.join(' ') }
        break
      }
    }
  }

  let outside: CategoryFact = category(rules.workspace.verdict)
  if (rules.workspace.enabled && workspaceRoot !== null && workspaceRoot.length > 0) {
    for (const path of pathsOf(call, rules)) {
      if (!isInside(workspaceRoot, path)) {
        outside = { matched: true, verdict: rules.workspace.verdict, rule: path }
        break
      }
    }
  }

  const required = netScope(call['net'])
  const net: CategoryFact = {
    matched: rules.net.enabled && required !== 'none' && netRank(required) > netRank(tierNet),
    verdict: rules.net.verdict,
    rule: required,
  }

  return {
    index,
    port,
    tool,
    invalid: false,
    forbidden,
    portAllowed,
    structural,
    mcp,
    danger,
    allow,
    outside,
    net,
    policy,
    mcpDefault: rules.mcp.default_verdict,
    workspaceVerdict: rules.workspace.verdict,
    netVerdict: rules.net.verdict,
  }
}

/**
 * `guard.facts({bag})`：解析规则 + 逐 call 命中事实（无裁决）。
 * bag 非对象 / calls 非数组 → `bad_args`（与迁移前同码 / 同文案）。
 * 入参包一层 `{bag}`：term 把调用参数原样传入，服务端校验 bag 本体。
 */
export function facts(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('bag must be an object')
  const bag = args['bag']
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
  const tierNet = netScope(bag['tier_net'])

  return {
    calls: calls.map((call, index) => factOf(call, index, rules, policy, workspaceRoot, tierNet)),
  }
}

/**
 * `guard.collect({list})`：把 term 逐 call 攒出的 cons 链（`{head, tail}` / `null`）材料化为数组。
 * 列表构造是 term 表达不了的机械步骤；本方法不含任何裁决语义。
 */
export function collect(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('collect args must be an object')
  let node: Json = args['list']
  const out: Json[] = []
  let steps = 0
  while (isRecord(node)) {
    out.push(node['head'])
    node = node['tail']
    steps += 1
    if (steps > 1_000_000) throw new BadArgsError('collect list too long')
  }
  out.reverse()
  return { decisions: out }
}
