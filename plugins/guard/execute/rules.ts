// guard 规则解析与内建机械兜底。
// 规则数据住本身份数据世代 body（bag.guard_rules，由调用方入口 term 读出随 bag 传入）；
// bag 未带规则（首次装配 / 未 seed）时用内建默认兜底（与 tools/default-body.json 同形）。

import type { Json, Rec, Verdict } from './types.ts'

export interface TierPolicy {
  outside: boolean
  danger: boolean
  mcp: boolean
  structural: boolean
}

export interface WorkspaceRule {
  enabled: boolean
  verdict: Verdict
  /** call 顶层路径键（默认 `["path"]`）。 */
  call_path_keys: string[]
  /** args 内路径键（默认 `["path", "paths"]`）。 */
  arg_path_keys: string[]
}

export interface DangerPattern {
  id: string
  verdict: Verdict
  /** OR-of-AND：任一组内 token 全部命中即匹配。 */
  any_of: string[][]
}

export interface McpTrusted {
  server: string
  confirmed: boolean
  trusted: boolean
}

export interface McpRule {
  port: string
  default_verdict: Verdict
  trusted: McpTrusted[]
}

export interface StructuralRule {
  port: string
  tool: string
  verdict: Verdict
}

export interface DenyRule {
  calls: { port: string; tool: string }[]
  /** null = 不按 port 门禁；数组 = 白名单外 deny。 */
  allowed_ports: string[] | null
}

export interface Rules {
  version: number
  tiers: Record<string, TierPolicy>
  workspace: WorkspaceRule
  danger_patterns: DangerPattern[]
  mcp: McpRule
  structural_writes: StructuralRule[]
  deny: DenyRule
}

/** 未知 / 缺失档位按 fail-closed：升级判定一律开启（不因档位缺失而静默放行）。 */
export const FAIL_CLOSED_TIER: TierPolicy = {
  outside: true,
  danger: true,
  mcp: true,
  structural: true,
}

/** 内建默认启发式（结构化形态见 tools/default-body.json）。 */
export const DEFAULT_RULES: Rules = {
  version: 1,
  tiers: {
    auto: { outside: false, danger: false, mcp: true, structural: false },
    severe: { outside: true, danger: true, mcp: true, structural: true },
    review: { outside: true, danger: true, mcp: true, structural: true },
    deny: { outside: true, danger: true, mcp: true, structural: true },
  },
  workspace: {
    enabled: true,
    verdict: 'escalate',
    call_path_keys: ['path'],
    arg_path_keys: ['path', 'paths'],
  },
  danger_patterns: [
    {
      id: 'recursive_delete',
      verdict: 'escalate',
      any_of: [
        ['rm', '-rf'],
        ['rm', '-r'],
        ['rm', '--recursive'],
        ['rmdir', '/s'],
        ['del', '/s'],
        ['remove-item', '-recurse'],
        ['shutil.rmtree'],
      ],
    },
    {
      id: 'privilege_change',
      verdict: 'escalate',
      any_of: [
        ['sudo'],
        ['runas'],
        ['chmod', 'u+s'],
        ['chmod', '+s'],
        ['chown'],
        ['takeown'],
        ['icacls', 'grant'],
        ['setfacl'],
      ],
    },
    {
      id: 'pipe_download_exec',
      verdict: 'escalate',
      any_of: [
        ['curl', '| sh'],
        ['curl', '| bash'],
        ['wget', '| sh'],
        ['wget', '| bash'],
        ['iwr', 'iex'],
        ['invoke-webrequest', 'invoke-expression'],
        ['downloadstring', 'iex'],
      ],
    },
    {
      id: 'registry_service',
      verdict: 'escalate',
      any_of: [
        ['reg add'],
        ['reg delete'],
        ['sc create'],
        ['sc config'],
        ['new-service'],
        ['set-service'],
        ['systemctl'],
        ['launchctl'],
      ],
    },
    {
      id: 'disk_format',
      verdict: 'escalate',
      any_of: [['format c:'], ['format /fs:'], ['format /q'], ['diskpart'], ['fdisk'], ['mkfs'], ['dd of=']],
    },
    {
      id: 'persistent_env',
      verdict: 'escalate',
      any_of: [['setx'], ['set-environmentvariable'], ['~/.bashrc'], ['~/.profile'], ['/etc/environment']],
    },
  ],
  mcp: {
    port: 'mcp',
    default_verdict: 'escalate',
    trusted: [],
  },
  structural_writes: [
    { port: 'plugin-admin', tool: 'plugin.write', verdict: 'escalate' },
    { port: 'orchestration-admin', tool: 'orchestration.propose', verdict: 'escalate' },
  ],
  deny: {
    calls: [],
    allowed_ports: null,
  },
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boolOr(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asVerdict(value: Json | undefined, fallback: Verdict): Verdict {
  return value === 'allow' || value === 'escalate' || value === 'deny' ? value : fallback
}

function stringArray(value: Json | undefined): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value as string[]
}

function parseTierPolicy(value: Json | undefined, fallback: TierPolicy): TierPolicy {
  if (!isRecord(value)) return fallback
  return {
    outside: boolOr(value['outside'], fallback.outside),
    danger: boolOr(value['danger'], fallback.danger),
    mcp: boolOr(value['mcp'], fallback.mcp),
    structural: boolOr(value['structural'], fallback.structural),
  }
}

function parseTiers(value: Json | undefined): Record<string, TierPolicy> {
  if (!isRecord(value)) return DEFAULT_RULES.tiers
  const tiers: Record<string, TierPolicy> = { ...DEFAULT_RULES.tiers }
  for (const [name, policy] of Object.entries(value)) {
    tiers[name] = parseTierPolicy(policy, tiers[name] ?? FAIL_CLOSED_TIER)
  }
  return tiers
}

function parseWorkspace(value: Json | undefined): WorkspaceRule {
  if (!isRecord(value)) return DEFAULT_RULES.workspace
  const base = DEFAULT_RULES.workspace
  return {
    enabled: boolOr(value['enabled'], base.enabled),
    verdict: asVerdict(value['verdict'], base.verdict),
    call_path_keys: stringArray(value['call_path_keys']) ?? base.call_path_keys,
    arg_path_keys: stringArray(value['arg_path_keys']) ?? base.arg_path_keys,
  }
}

function parsePatterns(value: Json | undefined): DangerPattern[] {
  if (value === undefined) return DEFAULT_RULES.danger_patterns
  if (!Array.isArray(value)) return DEFAULT_RULES.danger_patterns
  const out: DangerPattern[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = item['id']
    const anyOf = item['any_of']
    if (typeof id !== 'string' || id.length === 0 || !Array.isArray(anyOf)) continue
    const groups: string[][] = []
    for (const group of anyOf) {
      const tokens = stringArray(group)
      if (tokens !== null && tokens.length > 0) groups.push(tokens)
    }
    if (groups.length === 0) continue
    out.push({ id, verdict: asVerdict(item['verdict'], 'escalate'), any_of: groups })
  }
  return out
}

function parseTrusted(value: Json | undefined): McpTrusted[] {
  if (!Array.isArray(value)) return []
  const out: McpTrusted[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const server = item['server']
    if (typeof server !== 'string' || server.length === 0) continue
    out.push({
      server,
      confirmed: item['confirmed'] === true,
      trusted: item['trusted'] === true,
    })
  }
  return out
}

function parseMcp(value: Json | undefined): McpRule {
  if (!isRecord(value)) return DEFAULT_RULES.mcp
  const base = DEFAULT_RULES.mcp
  const port = value['port']
  return {
    port: typeof port === 'string' && port.length > 0 ? port : base.port,
    default_verdict: asVerdict(value['default_verdict'], base.default_verdict),
    trusted: parseTrusted(value['trusted']),
  }
}

function parseStructural(value: Json | undefined): StructuralRule[] {
  if (value === undefined) return DEFAULT_RULES.structural_writes
  if (!Array.isArray(value)) return DEFAULT_RULES.structural_writes
  const out: StructuralRule[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const port = item['port']
    const tool = item['tool']
    if (typeof port !== 'string' || port.length === 0) continue
    if (typeof tool !== 'string' || tool.length === 0) continue
    out.push({ port, tool, verdict: asVerdict(item['verdict'], 'escalate') })
  }
  return out
}

function parseDeny(value: Json | undefined): DenyRule {
  if (!isRecord(value)) return DEFAULT_RULES.deny
  const base = DEFAULT_RULES.deny
  const calls: { port: string; tool: string }[] = []
  if (Array.isArray(value['calls'])) {
    for (const item of value['calls']) {
      if (!isRecord(item)) continue
      const port = item['port']
      const tool = item['tool']
      if (typeof port === 'string' && port.length > 0 && typeof tool === 'string' && tool.length > 0) {
        calls.push({ port, tool })
      }
    }
  } else {
    calls.push(...base.calls)
  }
  let allowedPorts = base.allowed_ports
  if (value['allowed_ports'] === null) allowedPorts = null
  else {
    const parsed = stringArray(value['allowed_ports'])
    if (parsed !== null) allowedPorts = parsed
  }
  return { calls, allowed_ports: allowedPorts }
}

/** 解析 bag.guard_rules：非对象（缺省）用内建默认；逐段合并，段缺省回落默认。 */
export function parseRules(raw: Json | undefined): Rules {
  if (!isRecord(raw)) return DEFAULT_RULES
  return {
    version: typeof raw['version'] === 'number' ? raw['version'] : DEFAULT_RULES.version,
    tiers: parseTiers(raw['tiers']),
    workspace: parseWorkspace(raw['workspace']),
    danger_patterns: parsePatterns(raw['danger_patterns']),
    mcp: parseMcp(raw['mcp']),
    structural_writes: parseStructural(raw['structural_writes']),
    deny: parseDeny(raw['deny']),
  }
}
