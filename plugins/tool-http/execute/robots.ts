// robots.txt 解析：按 User-agent 分组，路径规则取最长匹配，`*` 通配、`$` 结尾锚。
// 纯函数、确定性；取不到 robots.txt 时由调用方决定放行（不阻断抓取）。

interface RobotsRule {
  allow: boolean
  path: string
}

interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
}

function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (key === 'user-agent') {
      if (current === null || current.rules.length > 0) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if (key === 'disallow' || key === 'allow') {
      if (current === null) {
        current = { agents: ['*'], rules: [] }
        groups.push(current)
      }
      current.rules.push({ allow: key === 'allow', path: value })
    }
  }
  return groups
}

function ruleMatches(pattern: string, path: string): boolean {
  if (pattern.length === 0) return false
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path)
}

function matchLength(pattern: string): number {
  return pattern.replace(/[*$]/g, '').length
}

/** 判定 userAgent 是否可抓取 path；无匹配组 / 无匹配规则视为允许。 */
export function robotsAllows(text: string, userAgent: string, path: string): boolean {
  const groups = parseGroups(text)
  const token = userAgent.toLowerCase()
  let chosen: RobotsGroup | null = null
  let chosenScore = -1
  for (const group of groups) {
    for (const agent of group.agents) {
      const score = agent === '*' ? 0 : token.includes(agent) ? agent.length : -1
      if (score > chosenScore) {
        chosen = group
        chosenScore = score
      }
    }
  }
  if (chosen === null) return true
  let best: RobotsRule | null = null
  for (const rule of chosen.rules) {
    if (!ruleMatches(rule.path, path)) continue
    if (best === null) {
      best = rule
      continue
    }
    const length = matchLength(rule.path)
    const bestLength = matchLength(best.path)
    if (length > bestLength || (length === bestLength && rule.allow && !best.allow)) best = rule
  }
  return best === null ? true : best.allow
}
