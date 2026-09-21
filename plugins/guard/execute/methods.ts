// 能力类 `guard` 的方法表：唯一方法 judge 是纯函数（见 judge.ts）。
// 服务不读投影、不自取时钟；tier / workspace_root / guard_rules 全由调用方随 bag 传入。

import { judge } from './judge.ts'
import type { Handler, Json } from './types.ts'

export const HANDLERS: Record<string, Handler> = {
  judge: (args: Json) => judge(args) as unknown as Json,
}
