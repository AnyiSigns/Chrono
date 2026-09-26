// 调用帧 `env` 的解析与固定时钟：宿主填写的机械字段，服务绝不自取时间。

import { isRecord } from './json.ts'
import type { Json } from './json.ts'
import type { CallEnv } from './types.ts'

/** 帧 env 解析；缺失 / 形态不合按 null / 0 回落。 */
export function parseCallEnv(raw: Json | undefined): CallEnv {
  if (!isRecord(raw)) return { run: null, thread: null, now: 0, emitter: null }
  return {
    run: typeof raw['run'] === 'string' ? raw['run'] : null,
    thread: typeof raw['thread'] === 'string' ? raw['thread'] : null,
    now: typeof raw['now'] === 'number' && Number.isFinite(raw['now']) ? raw['now'] : 0,
    emitter: typeof raw['emitter'] === 'string' ? raw['emitter'] : null,
  }
}

/** 固定时钟；env 缺失回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}
