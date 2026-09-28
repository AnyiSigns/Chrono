// 能力类 `model` 的方法表：chat / complete / vendors / discover / profile / sync。
// 只返回值 / 写计划；不落账、不读投影、不自取时钟。密钥经反向调用 secrets.resolve（明文只存本进程内存）。
// 依赖（反向调用链 / 令牌桶 / 事件出口）由入口按连接构造后注入。

import { chat, complete } from './chat.ts'
import { discover } from './discover.ts'
import { abortInflight } from './http.ts'
import { profile, sync } from './profile.ts'
import { vendors } from './vendors.ts'
import { isRecord } from './plan.ts'
import type { Handler, HandlerResult, Json, PortCaller } from 'plugin-sdk'
import type { RateLimiter } from './resilience.ts'

/** 单条连接的服务依赖：反向调用链（secrets / config）、令牌桶、事件出口。 */
export interface ModelDeps {
  secrets: PortCaller
  config: PortCaller
  limiter: RateLimiter
  emit: (topic: string, payload: Json) => void
}

/** 取 `args.turn_id`（非空字符串视为有值）。 */
function turnIdOf(args: Json): string | null {
  if (!isRecord(args)) return null
  const value = args['turn_id']
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * `abort(turn_id)`：销毁该回合在途 HTTP 请求（长推理不等窗口烧完、不继续计费）。
 * 缺 `turn_id` 或该回合无在途请求时是幂等 no-op，不是错误——模型调用另有旁路来源。
 */
function abort(args: Json): Json {
  const turnId = turnIdOf(args)
  if (turnId === null) return { ok: true, aborted: false, turn_id: null }
  return { ok: true, aborted: abortInflight(turnId), turn_id: turnId }
}

/** 构造方法表（依赖注入：反向调用链与限流器由入口按连接提供）。 */
export function createHandlers(deps: ModelDeps): Record<string, Handler> {
  const chatDeps = { secrets: deps.secrets, limiter: deps.limiter, emit: deps.emit }
  return {
    chat: async (args: Json, env): Promise<HandlerResult> => ({ value: await chat(chatDeps, args, env), events: [] }),
    complete: async (args: Json, env): Promise<HandlerResult> => ({ value: await complete(chatDeps, args, env), events: [] }),
    abort: (args: Json): Promise<HandlerResult> => Promise.resolve({ value: abort(args), events: [] }),
    vendors: (args: Json): Promise<HandlerResult> => Promise.resolve({ value: vendors(args), events: [] }),
    discover: async (args: Json, env): Promise<HandlerResult> => ({
      value: await discover(args, env, { secrets: deps.secrets, limiter: deps.limiter }),
      events: [],
    }),
    profile: async (args: Json, env): Promise<HandlerResult> => ({
      value: await profile(args, env, { limiter: deps.limiter, config: deps.config }),
      events: [],
    }),
    sync: async (args: Json, env): Promise<HandlerResult> => ({
      value: await sync(args, env, { limiter: deps.limiter, config: deps.config }),
      events: [],
    }),
  }
}
