// 瞬时重试循环（消费方）：可重试错误按指数退避；限流 / 冷却 / 退避决策由 `throttle` 提供方出（反向 `port.call`）。
// 循环本身住本插件（依赖流 reset 回调与逐段重试），本模块只编排「取策略 -> 取令牌 -> 跑 -> 退避重试」。
// 时间一律取调用帧 env.now（逻辑时钟，不自取时钟）；等待用真实定时器，等待时长不影响世界内容。

import { ModelError } from './errors.ts'
import { isRecord } from './plan.ts'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

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

/** 限流 / 退避决策接口：生产实现经反向 `port.call throttle.*`，单测注入假实现。 */
export interface Throttle {
  acquire(provider: string, now: number, policy: RetryPolicy): Promise<number>
  penalize(provider: string, now: number, retryAfterMs: number, policy: RetryPolicy): Promise<void>
  plan(attempt: number, policy: RetryPolicy, retryAfterMs?: number): Promise<number>
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function bool(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 归一提供方回的 RetryPolicy；缺字段回落安全缺省。 */
function asPolicy(value: Rec): RetryPolicy {
  const bucket = isRecord(value['token_bucket']) ? (value['token_bucket'] as Rec) : {}
  return {
    max_retries: positiveInt(value['max_retries'], 2),
    backoff_ms: positiveInt(value['backoff_ms'], 200),
    backoff_max_ms: positiveInt(value['backoff_max_ms'], 5000),
    jitter: bool(value['jitter'], false),
    request_timeout_ms: positiveInt(value['request_timeout_ms'], 300000),
    connect_timeout_ms: positiveInt(value['connect_timeout_ms'], 30000),
    token_bucket: {
      capacity: positiveInt(bucket['capacity'], 8),
      refill_per_sec: positiveInt(bucket['refill_per_sec'], 1),
    },
    models_dev_url:
      typeof value['models_dev_url'] === 'string' && value['models_dev_url'].length > 0
        ? (value['models_dev_url'] as string)
        : 'https://models.dev/api.json',
  }
}

function throttleFailed(
  method: string,
  outcome: { ok: boolean; code?: string; value?: Json },
): ModelError {
  return new ModelError(
    'model_unsupported',
    `throttle.${method} failed: ${outcome.ok ? 'bad value' : outcome.code}`,
  )
}

/** 解析本次调用的韧性策略：经反向 `port.call throttle.policy`（含调用方覆盖）。 */
export async function fetchPolicy(throttle: PortCaller, override?: Json): Promise<RetryPolicy> {
  const outcome = await throttle.call('throttle', 'policy', { override: override ?? null })
  if (!outcome.ok || !isRecord(outcome.value)) throw throttleFailed('policy', outcome)
  return asPolicy(outcome.value)
}

/** 把反向调用链适配成 `Throttle`：acquire / penalize / plan 逐次 `port.call`。 */
export function portThrottle(caller: PortCaller): Throttle {
  return {
    async acquire(provider, now, policy) {
      const outcome = await caller.call('throttle', 'acquire', {
        provider,
        now,
        policy: policy as unknown as Rec,
      })
      if (!outcome.ok || !isRecord(outcome.value) || typeof outcome.value['wait_ms'] !== 'number') {
        throw throttleFailed('acquire', outcome)
      }
      return outcome.value['wait_ms'] as number
    },
    async penalize(provider, now, retryAfterMs, policy) {
      const outcome = await caller.call('throttle', 'penalize', {
        provider,
        now,
        retry_after_ms: retryAfterMs,
        policy: policy as unknown as Rec,
      })
      if (!outcome.ok) throw throttleFailed('penalize', outcome)
    },
    async plan(attempt, policy, retryAfterMs) {
      const args: Rec = { attempt, policy: policy as unknown as Rec }
      if (retryAfterMs !== undefined) args['retry_after_ms'] = retryAfterMs
      const outcome = await caller.call('throttle', 'plan', args)
      if (
        !outcome.ok ||
        !isRecord(outcome.value) ||
        typeof outcome.value['delay_ms'] !== 'number'
      ) {
        throw throttleFailed('plan', outcome)
      }
      return outcome.value['delay_ms'] as number
    },
  }
}

export interface RetryDeps {
  policy: RetryPolicy
  throttle: Throttle
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
export async function withRetry<T>(
  provider: string,
  run: () => Promise<T>,
  deps: RetryDeps,
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep
  // 逻辑时钟：等待多久就推进多久，使 429 冷却在同一调用内可过期（不自取真实时间）。
  let clock = deps.now
  for (let attempt = 0; ; attempt += 1) {
    // 取令牌：等待被 backoff_max_ms 截断后必须重新判定（否则在 429 冷却 / 缺令牌下照发请求）
    for (;;) {
      const waitMs = await deps.throttle.acquire(provider, clock, deps.policy)
      if (waitMs <= 0) break
      const capped = Math.min(waitMs, deps.policy.backoff_max_ms)
      await sleep(capped)
      clock += capped
    }
    try {
      return await run()
    } catch (err) {
      if (!(err instanceof ModelError) || !err.retryable || attempt >= deps.policy.max_retries)
        throw err
      if (err.code === 'model_rate_limited') {
        await deps.throttle.penalize(
          provider,
          clock,
          err.retryAfterMs ?? deps.policy.backoff_ms,
          deps.policy,
        )
      }
      const delay = await deps.throttle.plan(attempt, deps.policy, err.retryAfterMs)
      await sleep(delay)
      clock += delay
    }
  }
}
