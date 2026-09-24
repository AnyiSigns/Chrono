// 调用韧性（v1 全做）：瞬时重试、指数退避、429 尊重 Retry-After + 每 provider 令牌桶。
// 令牌桶状态落 `CHRONO_PLUGIN_STATE` ③ 目录（可重算）；目录缺失 / 不可读写时安全降级为进程内存。
// 时间一律取调用帧 env.now（不自取时钟）；退避等待用真实定时器，但等待时长不影响世界内容。

import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { ModelError } from './errors.ts'
import { isRecord } from './plan.ts'
import { schemaConfig } from './plugin.ts'
import type { Json, Rec } from './types.ts'

/** 崩溃残留的临时文件视为过期的阈值：活跃写者的临时文件不会存活这么久。 */
const STALE_TEMP_MS = 60 * 60 * 1000

/** 机会式回收：清理同目录中本模块遗留的过期临时文件，避免崩溃残留的 `.tmp` 堆积。 */
function sweepStaleTemps(dir: string, prefix: string): void {
  try {
    const cutoff = Date.now() - STALE_TEMP_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        // 单文件 stat / 删除失败不影响本次写入
      }
    }
  } catch {
    // 目录不可读：跳过回收
  }
}

/** 原子写：先写同目录唯一临时文件再 rename 替换，读方永不看到半截 JSON。 */
function writeFileAtomic(file: string, data: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    sweepStaleTemps(dirname(file), `${basename(file)}.`)
    writeFileSync(temporary, data, 'utf8')
    renameSync(temporary, file)
  } catch (err) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 临时文件清理失败不掩盖原始错误
    }
    throw err
  }
}

export interface RetryPolicy {
  max_retries: number
  backoff_ms: number
  backoff_max_ms: number
  jitter: boolean
  request_timeout_ms: number
  connect_timeout_ms: number
  token_bucket: { capacity: number; refill_per_sec: number }
  models_dev_url: string
}

const FALLBACK_POLICY: RetryPolicy = {
  max_retries: 2,
  backoff_ms: 200,
  backoff_max_ms: 5000,
  jitter: false,
  request_timeout_ms: 300000,
  connect_timeout_ms: 30000,
  token_bucket: { capacity: 8, refill_per_sec: 1 },
  models_dev_url: 'https://models.dev/api.json',
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function bool(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 合并策略：schema 自用键 -> 兜底 -> 调用方覆盖（bag.resilience）。 */
export function resolvePolicy(override?: Json): RetryPolicy {
  const base = schemaConfig()
  const source = isRecord(override) ? { ...base, ...override } : base
  const bucket = isRecord(source['token_bucket']) ? (source['token_bucket'] as Rec) : {}
  return {
    max_retries: positiveInt(source['max_retries'], FALLBACK_POLICY.max_retries),
    backoff_ms: positiveInt(source['backoff_ms'], FALLBACK_POLICY.backoff_ms),
    backoff_max_ms: positiveInt(source['backoff_max_ms'], FALLBACK_POLICY.backoff_max_ms),
    jitter: bool(source['jitter'], FALLBACK_POLICY.jitter),
    request_timeout_ms: positiveInt(source['request_timeout_ms'], FALLBACK_POLICY.request_timeout_ms),
    connect_timeout_ms: positiveInt(source['connect_timeout_ms'], FALLBACK_POLICY.connect_timeout_ms),
    token_bucket: {
      capacity: positiveInt(bucket['capacity'], FALLBACK_POLICY.token_bucket.capacity),
      refill_per_sec: positiveInt(bucket['refill_per_sec'], FALLBACK_POLICY.token_bucket.refill_per_sec),
    },
    models_dev_url:
      typeof source['models_dev_url'] === 'string' && source['models_dev_url'].length > 0
        ? (source['models_dev_url'] as string)
        : FALLBACK_POLICY.models_dev_url,
  }
}

interface BucketState {
  tokens: number
  updated_at: number
  cooldown_until: number
}

function defaultBucket(): BucketState {
  return { tokens: 0, updated_at: 0, cooldown_until: 0 }
}

/**
 * 每 provider 令牌桶：429 后置冷却（尊重 Retry-After），并按速率补充令牌。
 * 状态持久化到插件 ③ 目录；任何读写失败都只影响本次进程（可重算）。
 */
export class RateLimiter {
  private readonly file: string | null
  private readonly state: Map<string, BucketState>

  constructor(file: string | null) {
    this.file = file
    this.state = new Map()
    this.load()
  }

  /** 取一个令牌；返回需要等待的毫秒数（0 = 可立即调用）。 */
  acquire(provider: string, now: number, policy: RetryPolicy): number {
    const bucket = this.refill(provider, now, policy)
    if (bucket.cooldown_until > now) return bucket.cooldown_until - now
    if (bucket.tokens < 1) {
      const missing = 1 - bucket.tokens
      return Math.ceil(missing / (policy.token_bucket.refill_per_sec / 1000))
    }
    bucket.tokens -= 1
    this.save()
    return 0
  }

  /** 429 惩罚：置冷却到 now + retryAfter（缺省一个退避基数）。 */
  penalize(provider: string, now: number, retryAfterMs: number, policy: RetryPolicy): void {
    const bucket = this.refill(provider, now, policy)
    bucket.cooldown_until = now + retryAfterMs
    bucket.tokens = 0
    this.save()
  }

  private refill(provider: string, now: number, policy: RetryPolicy): BucketState {
    const bucket = this.state.get(provider) ?? defaultBucket()
    const elapsed = Math.max(0, now - bucket.updated_at)
    const gained = (elapsed * policy.token_bucket.refill_per_sec) / 1000
    bucket.tokens = Math.min(policy.token_bucket.capacity, bucket.tokens + gained)
    bucket.updated_at = now
    this.state.set(provider, bucket)
    return bucket
  }

  private load(): void {
    if (this.file === null) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Json
      if (!isRecord(parsed)) return
      for (const [provider, value] of Object.entries(parsed)) {
        if (!isRecord(value)) continue
        this.state.set(provider, {
          tokens: typeof value['tokens'] === 'number' ? value['tokens'] : 0,
          updated_at: typeof value['updated_at'] === 'number' ? value['updated_at'] : 0,
          cooldown_until: typeof value['cooldown_until'] === 'number' ? value['cooldown_until'] : 0,
        })
      }
    } catch {
      // 状态文件缺失 / 损坏：可重算，忽略并从空表开始。
    }
  }

  private save(): void {
    if (this.file === null) return
    try {
      const payload: Rec = {}
      for (const [provider, value] of this.state) {
        payload[provider] = { tokens: value.tokens, updated_at: value.updated_at, cooldown_until: value.cooldown_until }
      }
      writeFileAtomic(this.file, JSON.stringify(payload))
    } catch {
      // ③ 目录不存在 / 不可写：安全降级为进程内存。
    }
  }
}

/** 状态文件路径：`CHRONO_PLUGIN_STATE` 存在时用之，否则 null（纯内存）。 */
export function rateLimitFile(): string | null {
  const dir = process.env['CHRONO_PLUGIN_STATE']
  if (typeof dir !== 'string' || dir.length === 0) return null
  return join(dir, 'rate-limit.json')
}

export interface RetryDeps {
  policy: RetryPolicy
  limiter: RateLimiter
  now: number
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 瞬时重试循环：可重试错误按指数退避（429 额外置冷却）；不可重试立即抛出。 */
export async function withRetry<T>(provider: string, run: () => Promise<T>, deps: RetryDeps): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep
  // 逻辑时钟：等待多久就推进多久，使 429 冷却在同一调用内可过期（不自取真实时间）。
  let clock = deps.now
  for (let attempt = 0; ; attempt += 1) {
    // 取令牌：等待被 backoff_max_ms 截断后必须重新判定（否则在 429 冷却 / 缺令牌下照发请求）
    for (;;) {
      const waitMs = deps.limiter.acquire(provider, clock, deps.policy)
      if (waitMs <= 0) break
      const capped = Math.min(waitMs, deps.policy.backoff_max_ms)
      await sleep(capped)
      clock += capped
    }
    try {
      return await run()
    } catch (err) {
      if (!(err instanceof ModelError) || !err.retryable || attempt >= deps.policy.max_retries) throw err
      if (err.code === 'model_rate_limited') {
        deps.limiter.penalize(provider, clock, err.retryAfterMs ?? deps.policy.backoff_ms, deps.policy)
      }
      let delay = Math.min(deps.policy.backoff_ms * 2 ** attempt, deps.policy.backoff_max_ms)
      if (err.retryAfterMs !== undefined) delay = Math.max(delay, err.retryAfterMs)
      if (deps.policy.jitter) delay = Math.round(delay * (0.5 + Math.random() * 0.5))
      await sleep(delay)
      clock += delay
    }
  }
}
