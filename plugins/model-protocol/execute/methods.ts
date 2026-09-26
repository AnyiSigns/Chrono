// 能力类 `model` 的方法表：chat / complete / vendors / discover / profile / sync。
// 只返回值 / 写计划；不落账、不读投影、不自取时钟。密钥经反向调用 secrets.resolve（明文只存本进程内存）。
// 依赖（反向调用链 / 令牌桶 / 事件出口）由入口按连接构造后注入。

import { chat, complete } from './chat.ts'
import { discover } from './discover.ts'
import { profile, sync } from './profile.ts'
import { vendors } from './vendors.ts'
import type { Handler, HandlerResult, Json, PortCaller } from 'plugin-sdk'
import type { RateLimiter } from './resilience.ts'

/** 单条连接的服务依赖：反向调用链（secrets / config）、令牌桶、事件出口。 */
export interface ModelDeps {
  secrets: PortCaller
  config: PortCaller
  limiter: RateLimiter
  emit: (topic: string, payload: Json) => void
}

/** 构造方法表（依赖注入：反向调用链与限流器由入口按连接提供）。 */
export function createHandlers(deps: ModelDeps): Record<string, Handler> {
  const chatDeps = { secrets: deps.secrets, limiter: deps.limiter, emit: deps.emit }
  return {
    chat: async (args: Json, env): Promise<HandlerResult> => ({ value: await chat(chatDeps, args, env), events: [] }),
    complete: async (args: Json, env): Promise<HandlerResult> => ({ value: await complete(chatDeps, args, env), events: [] }),
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
