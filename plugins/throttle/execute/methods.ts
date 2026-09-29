// 能力类 `throttle` 的方法表：policy / acquire / plan / penalize。
// 纯「状态 + 决策」：不读投影、不写世界、不自取时钟（now 由调用方传入逻辑时钟）。
// 消费方（model-protocol）持重试循环，本服务只回答「要不要等、等多久、冷却多久」。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { RateLimiter, planDelay, resolvePolicy } from './throttle.ts'
import type { RetryPolicy } from './throttle.ts'
import type { Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

export interface ThrottleDeps {
  limiter: RateLimiter
}

function recordOf(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} required`)
  return value
}

function policyOf(args: Rec): RetryPolicy {
  const policy = args['policy']
  if (policy === undefined) return resolvePolicy(undefined)
  return resolvePolicy(policy)
}

function requireProvider(args: Rec): string {
  const provider = args['provider']
  if (typeof provider !== 'string' || provider.length === 0)
    throw new BadArgsError('provider required')
  return provider
}

function requireNow(args: Rec): number {
  const now = args['now']
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new BadArgsError('now required')
  return now
}

/** 构造方法表（令牌桶由入口按连接提供）。四方法皆纯同步决策，回值即时。 */
export function createHandlers(deps: ThrottleDeps): Record<string, Handler> {
  return {
    policy: (args: Json): HandlerResult => {
      const record = isRecord(args) ? args : {}
      const value = resolvePolicy(record['override']) as unknown as Json
      return { value, events: [] }
    },
    acquire: (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const waitMs = deps.limiter.acquire(
        requireProvider(record),
        requireNow(record),
        policyOf(record),
      )
      return { value: { wait_ms: waitMs }, events: [] }
    },
    plan: (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const attempt = record['attempt']
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
        throw new BadArgsError('attempt required')
      }
      const retryAfter = record['retry_after_ms']
      const delayMs = planDelay(
        attempt,
        policyOf(record),
        typeof retryAfter === 'number' ? retryAfter : undefined,
      )
      return { value: { delay_ms: delayMs }, events: [] }
    },
    penalize: (args: Json): HandlerResult => {
      const record = recordOf(args, 'args')
      const retryAfter = record['retry_after_ms']
      deps.limiter.penalize(
        requireProvider(record),
        requireNow(record),
        typeof retryAfter === 'number' ? retryAfter : 0,
        policyOf(record),
      )
      return { value: { ok: true }, events: [] }
    },
  }
}
