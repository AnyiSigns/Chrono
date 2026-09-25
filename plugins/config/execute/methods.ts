// 能力类 `config` 的方法：`read` / `write`。
// 用户配置 / 界面配置（ui / providers / vendor / model）是运行记录，写即时落自有持久存储（④）；
// 判定阈值（permission / params）仍镜像进世界（`config.write` 有阈值变化时返回世界写计划）。
// 读把世界遗留 body 作基线、自有存储覆盖其上（存量可读、不搬）；服务不读投影（世界切片随 args 传入）。

import { applyPatch, canonicalEqual, isRecord, thresholdsOf } from './plan.ts'
import { ConfigStore } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

export interface ConfigDeps {
  store: ConfigStore
}

/** 服务内可变状态：上次读到的合并结果（写口据此读-改-写）与上次镜像进世界的阈值。 */
export interface ConfigState {
  merged: Rec | null
  worldMirror: Rec | null
}

export function createState(): ConfigState {
  return { merged: null, worldMirror: null }
}

function worldBodyOf(args: Json): Rec {
  if (!isRecord(args)) return {}
  const body = args['body']
  return isRecord(body) ? body : {}
}

function patchOf(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const patch = args['patch']
  if (isRecord(patch)) return patch
  // 兼容裸补丁（无 `patch` 包装）：去掉已知元字段后即补丁本体。
  const { patch: _ignored, ...rest } = args
  return rest
}

/** `read`：世界遗留 body 作基线 + 自有存储覆盖 → 整份配置视图；缓存合并结果供 `write` 读-改-写。 */
function read(args: Json, _env: CallEnv, deps: ConfigDeps, state: ConfigState): Json {
  const worldBody = worldBodyOf(args)
  const merged = applyPatch(worldBody, deps.store.body())
  state.merged = merged
  state.worldMirror = thresholdsOf(worldBody)
  const active = isRecord(args) && typeof args['active'] === 'string' ? (args['active'] as string) : null
  return { active, data_gen: null, pins: {}, refs: {}, body: merged }
}

/** 世界阈值镜像写计划：`put(阈值子集) + add_gen(config)`。 */
function thresholdPlan(thresholds: Rec): Json {
  return {
    $directives: [
      {
        kind: 'write',
        request: {
          op: 'batch',
          args: {
            ops: [
              { op: 'put', args: { body: thresholds } },
              { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
        },
      },
    ],
  }
}

/**
 * `write`：补丁读-改-写自有存储；阈值变化时额外回世界写计划镜像 `permission` / `params`。
 * 入参支持 `{patch}`（深合并，ui-shell / ui-composer / ui-sidebar 用）与 `{body}`（整份替换，
 * ui-settings 导入 / 厂商保存用）。
 */
function write(args: Json, env: CallEnv, deps: ConfigDeps, state: ConfigState): Json {
  const next =
    isRecord(args) && isRecord(args['body'])
      ? (args['body'] as Rec)
      : applyPatch(state.merged ?? deps.store.body(), patchOf(args))
  const changed = deps.store.write(env.run, next)
  state.merged = next
  const thresholds = thresholdsOf(next)
  if (!canonicalEqual(thresholds as Json, (state.worldMirror ?? {}) as Json)) {
    state.worldMirror = thresholds
    return thresholdPlan(thresholds)
  }
  return { ok: true, changed }
}

/** 构造方法表（依赖注入：存储由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: ConfigDeps): Record<string, Handler> {
  const state = createState()
  return {
    read: (args: Json, env: CallEnv): Promise<HandlerResult> =>
      Promise.resolve({ value: read(args, env, deps, state) }),
    write: (args: Json, env: CallEnv): Promise<HandlerResult> =>
      Promise.resolve({ value: write(args, env, deps, state) }),
  }
}
