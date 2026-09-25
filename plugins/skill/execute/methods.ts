// 能力类 `skill` 的方法：`read` / `write`。
// 技能清单是运行记录，已出世界：写即时落自有持久存储（④），读从自有存储取（世界遗留 body 作基线合并）。
// 服务不读投影（世界切片随 args 传入）、不自取时钟。

import { applyPatch, isRecord } from './plan.ts'
import { SkillStore } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

export interface SkillDeps {
  store: SkillStore
}

function worldBodyOf(args: Json): Rec {
  if (!isRecord(args)) return {}
  const body = args['body']
  return isRecord(body) ? body : {}
}

/** `read`：世界遗留 body 作基线 + 自有存储覆盖 → 整份技能视图。 */
function read(args: Json, _env: CallEnv, deps: SkillDeps): Json {
  const worldBody = worldBodyOf(args)
  const merged = applyPatch(worldBody, deps.store.body())
  const active = isRecord(args) && typeof args['active'] === 'string' ? (args['active'] as string) : null
  return { active, data_gen: null, pins: {}, refs: {}, body: merged }
}

/** `write`：整份替换清单（`{body}` 或裸 body）；内容未变短路。 */
function write(args: Json, env: CallEnv, deps: SkillDeps): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const body = isRecord(args['body']) ? (args['body'] as Rec) : args
  if (!Array.isArray(body['skills'])) throw new BadArgsError('body must contain skills[]')
  const changed = deps.store.write(env.run, { ...body, version: 1 })
  return { ok: true, changed }
}

/** 构造方法表（依赖注入：存储由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: SkillDeps): Record<string, Handler> {
  return {
    read: (args: Json, env: CallEnv): Promise<HandlerResult> => Promise.resolve({ value: read(args, env, deps) }),
    write: (args: Json, env: CallEnv): Promise<HandlerResult> => Promise.resolve({ value: write(args, env, deps) }),
  }
}
