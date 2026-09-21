// 能力类 `tool-shell` 的方法表：`describe` 回报工具声明，`invoke` 经反向调用执行。
// 服务不读投影、不自取时钟；tier / workspace_root / caps / grant / sandbox_tiers 全由调用方随 bag 传入。

import { describeTools } from './describe.ts'
import { invoke } from './invoke.ts'
import type { InvokeDeps } from './invoke.ts'
import type { Handler, Json } from './types.ts'

/** 构造方法表（依赖注入：执行与密钥后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: InvokeDeps): Record<string, Handler> {
  return {
    describe: async (): Promise<Json> => describeTools(),
    invoke: (args: Json): Promise<Json> => invoke(args, deps),
  }
}
