// 能力类 `model` 的方法表：chat / complete / vendors / discover / profile / sync。
// 只返回值 / 写计划；不落账、不读投影、不自取时钟。密钥经反向调用 secrets.resolve（明文只存本进程内存）。

import { chat, complete } from './chat.ts'
import { discover } from './discover.ts'
import { emitEvent } from './events.ts'
import { PortLink } from './port-link.ts'
import { profile, sync } from './profile.ts'
import { RateLimiter, rateLimitFile } from './resilience.ts'
import { vendors } from './vendors.ts'
import type { Handler, HandlerResult, Json } from './types.ts'

/** 反向调用链（服务 → 宿主 → secrets）：解析 auth_ref，明文不进 args / 结果 / 日志 / 事件。 */
export const SECRETS = new PortLink()

/** 反向调用链（服务 → 宿主 → config）：档案同步读-改-写 config owner 自有存储（运行记录已出世界）。 */
export const CONFIG = new PortLink()

/** 每 provider 令牌桶（状态落插件 ③ 目录，可重算；目录缺失时安全降级为进程内存）。 */
export const LIMITER = new RateLimiter(rateLimitFile())

const CHAT_DEPS = { secrets: SECRETS, limiter: LIMITER, emit: emitEvent }

export const HANDLERS: Record<string, Handler> = {
  chat: async (args: Json, env): Promise<HandlerResult> => ({ value: await chat(CHAT_DEPS, args, env) }),
  complete: async (args: Json, env): Promise<HandlerResult> => ({ value: await complete(CHAT_DEPS, args, env) }),
  vendors: (args: Json): Promise<HandlerResult> => Promise.resolve({ value: vendors(args) }),
  discover: async (args: Json, env): Promise<HandlerResult> => ({
    value: await discover(args, env, { secrets: SECRETS, limiter: LIMITER }),
  }),
  profile: async (args: Json, env): Promise<HandlerResult> => ({
    value: await profile(args, env, { limiter: LIMITER, config: CONFIG }),
  }),
  sync: async (args: Json, env): Promise<HandlerResult> => ({
    value: await sync(args, env, { limiter: LIMITER, config: CONFIG }),
  }),
}
