// context-window 测试用假提供方（token-estimate / budget）：仅在测试进程内仿真反向 port.call 应答，
// 不 import 任何兄弟插件源码（插件间不得直连）；这些原语的真实行为由其各自插件的测试覆盖。
// 这里只保证「消费方编排 + 端口契约形状」可测：v1 批量计数、预算建模、每模型系数与 EWMA 校准。

// ── v1 估算器（与 token-estimate 提供方同口径的最小实现） ──────────────────────

const OTHER_BUCKET = 4

function isCjk(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x2f00 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  )
}

function isAsciiWord(cp) {
  return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95
}

function isWhitespace(ch) {
  return ch === '\ufeff' ? false : /\s/u.test(ch)
}

/** 按 v1 规格估算 token 数（纯函数、确定）。 */
export function countText(text) {
  let cjk = 0
  let words = 0
  let others = 0
  let inWord = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (isCjk(cp)) {
      inWord = false
      cjk += 1
    } else if (isAsciiWord(cp)) {
      if (!inWord) {
        words += 1
        inWord = true
      }
    } else if (isWhitespace(ch)) {
      inWord = false
    } else {
      inWord = false
      others += 1
    }
  }
  return cjk + words + Math.ceil(others / OTHER_BUCKET)
}

// ── 预算建模（与 budget 提供方同口径的最小实现） ──────────────────────────────

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function ratioOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

const QUOTA_DEFAULTS = { skill: 0.1, style: 0.03 }

export function computeBudget(args) {
  const config = args?.config ?? null
  const policy = args?.policy ?? {}
  const quotaPolicy = policy.quota ?? {}
  const flags = []
  const contextWindow = positiveNumber(config?.context_window)
  const maxOutput = positiveNumber(config?.max_output)
  const window = contextWindow ?? ratioOf(policy.default_context_window, 8192)
  const output = maxOutput ?? ratioOf(policy.default_max_output, 1024)
  if (contextWindow === null || maxOutput === null) flags.push('profile_missing')
  const margin = Math.floor(window * ratioOf(policy.margin_ratio, 0.05))
  // 与 budget 提供方同口径：输入预算 = 窗 − 余量；max_output 只作请求输出上限天花板（≤ 窗）。
  const budget = window - margin
  const cap = (ratio) => Math.floor(budget * ratio)
  return {
    budget,
    context_window: window,
    max_output: Math.min(output, window),
    margin,
    origin: contextWindow === null || maxOutput === null ? 'default' : 'profile',
    flags,
    quota: {
      skill: cap(ratioOf(quotaPolicy.skill, QUOTA_DEFAULTS.skill)),
      style: cap(ratioOf(quotaPolicy.style, QUOTA_DEFAULTS.style)),
    },
  }
}

const PROMPT_KEYS = ['prompt_tokens', 'input_tokens', 'inputTokens']
const CACHED_KEYS = ['cached_tokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens']
const CACHE_CREATION_KEYS = ['cache_creation_input_tokens']
const COMPLETION_KEYS = ['completion_tokens', 'output_tokens', 'outputTokens']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/** 解析模型回包真实用量（与 budget 提供方同口径）。 */
export function parseUsage(value) {
  if (!isRecord(value)) return null
  const prompt = firstNumber(value, PROMPT_KEYS)
  if (prompt === null) return null
  let cached = 0
  for (const key of CACHED_KEYS) {
    const hit = firstNumber(value, [key])
    if (hit !== null) cached += hit
  }
  return {
    prompt_tokens: prompt,
    cached_tokens: cached,
    cache_creation_tokens: firstNumber(value, CACHE_CREATION_KEYS) ?? 0,
    completion_tokens: firstNumber(value, COMPLETION_KEYS) ?? 0,
    hit_rate: prompt > 0 ? cached / prompt : null,
    correction_factor: null,
  }
}

const EWMA_WEIGHT = 0.2
const FACTOR_MIN = 0.5
const FACTOR_MAX = 2

function clamp(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, value))
}

/** 内存假 budget：model / factor / observe（EWMA 校准）。 */
export function createFakeBudget() {
  const state = new Map()
  return {
    state,
    reset() {
      state.clear()
    },
    model(args) {
      return computeBudget(args)
    },
    factor(model) {
      const entry = state.get(model)
      return entry === undefined ? 1 : entry.factor
    },
    observe(model, estimate, usage) {
      const parsed = parseUsage(usage)
      const entry = state.get(model) ?? { factor: 1, last_estimate: 0 }
      let factor = entry.factor
      if (parsed !== null && parsed.prompt_tokens > 0 && entry.last_estimate > 0) {
        const ratio = parsed.prompt_tokens / entry.last_estimate
        factor = clamp(entry.factor * (1 - EWMA_WEIGHT + EWMA_WEIGHT * ratio))
      }
      state.set(model, { factor, last_estimate: estimate })
      return { factor, usage: parsed }
    },
  }
}

/** 直调 `buildAssembly` 用的假后端（进程内 v1 计数 + 内存假 budget）。 */
export function createFakeBackends(budget = createFakeBudget()) {
  return {
    budget,
    token: {
      async count(texts) {
        return texts.map((text) => countText(String(text)))
      },
      async version() {
        return 'v1'
      },
    },
  }
}

// ── 端口应答 ───────────────────────────────────────────────────────────────

/** token-estimate / budget 的默认反向应答；未知端口返回 null（驱动据此回 not_ready）。 */
export function defaultPortResponse(port, method, args, budget) {
  if (port === 'token-estimate') {
    if (method === 'count') {
      const texts = Array.isArray(args?.texts) ? args.texts : []
      return { value: { counts: texts.map((text) => countText(String(text))) } }
    }
    if (method === 'version') return { value: { version: 'v1' } }
    return null
  }
  if (port === 'budget') {
    if (method === 'model') return { value: budget.model(args) }
    if (method === 'factor') return { value: { factor: budget.factor(args?.model) } }
    if (method === 'observe')
      return { value: budget.observe(args?.model, args?.estimate, args?.usage) }
    return null
  }
  return null
}
