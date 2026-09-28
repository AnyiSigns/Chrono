// 能力类 `tool-shell` 的方法表：`describe` 回报工具声明，`invoke` 经反向调用执行。
// 服务不读投影、不自取时钟；tier / workspace_root / caps / grant / sandbox_tiers 全由调用方随 bag 传入。

import { describeTools } from './describe.ts'
import { invoke } from './invoke.ts'
import type { InvokeDeps } from './invoke.ts'
import type { Handler, Json } from './types.ts'
import type { CallEnv } from 'plugin-sdk'

/** 会话键：按线程隔离（cd / 环境变量在会话内延续），缺省回 run，再缺省 `default`。 */
function sessionIdOf(env: CallEnv | undefined): string {
  const thread = env?.thread
  if (typeof thread === 'string' && thread.length > 0) return thread
  const run = env?.run
  if (typeof run === 'string' && run.length > 0) return run
  return 'default'
}

/** 构造方法表（依赖注入：执行与密钥后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: InvokeDeps): Record<string, Handler> {
  return {
    describe: () => ({ value: describeTools(deps.profile), events: [] }),
    invoke: async (args: Json, env: CallEnv): Promise<{ value: Json; events: [] }> => ({
      value: await invoke(args, deps, sessionIdOf(env)),
      events: [],
    }),
  }
}
