// 能力类 `input` 的方法：输入槽运行记录写自有持久存储（④），不构造世界写计划。
// read 回整份槽体；write 覆盖一个线程键；clear 把一个线程键置 idle（回合消费后清槽）。
// 服务不读投影、不自取时钟。

import { InputStore, MAIN_THREAD } from './store.ts'
import type { Json, Rec } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler } from './types.ts'

export interface InputDeps {
  store: InputStore
}

function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function threadOf(args: Rec | null, env: CallEnv): string {
  const fromArgs = args !== null ? asString(args['thread_id']) ?? asString(args['thread']) : null
  return fromArgs ?? asString(env.thread) ?? MAIN_THREAD
}

/** `read`：回整份槽体 `{slots:{…}}`（可选 thread 仅用于附带该线程当前槽）。 */
function read(args: Json, env: CallEnv, deps: InputDeps): { value: Json; events: [] } {
  const body = deps.store.body()
  const record = isRecord(args) ? args : null
  const thread = record !== null ? asString(record['thread']) : null
  if (thread !== null) {
    return { value: { ...body, thread, slot: deps.store.get(thread) }, events: [] }
  }
  void env
  return { value: body, events: [] }
}

/** `write`：覆盖本线程槽（args.slot 必填；形状校验归写入端）。 */
function write(args: Json, env: CallEnv, deps: InputDeps): { value: Json; events: [] } {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  if (!Object.hasOwn(args, 'slot')) throw new BadArgsError('slot required')
  const thread = threadOf(args, env)
  deps.store.set(env.run, thread, args['slot'] ?? null)
  return { value: { ok: true, thread }, events: [] }
}

/** `clear`：把本线程槽置 `{kind:'idle'}`（其余线程键不动）。 */
function clear(args: Json, env: CallEnv, deps: InputDeps): { value: Json; events: [] } {
  const record = isRecord(args) ? args : null
  const thread = threadOf(record, env)
  deps.store.set(env.run, thread, { kind: 'idle' })
  return { value: { ok: true, thread }, events: [] }
}

export function createHandlers(deps: InputDeps): Record<string, Handler> {
  return {
    read: (args, env) => read(args, env, deps),
    write: (args, env) => write(args, env, deps),
    clear: (args, env) => clear(args, env, deps),
  }
}
