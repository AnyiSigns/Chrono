// 能力类 `guard` 的方法表：judge 由 term 承载（plugin.json.judgments），服务只提供取数与列表材料化。
// 服务不读投影、不自取时钟；tier / workspace_root / guard_rules 全由调用方随 bag 传入。

import { collect, facts } from './facts.ts'
import type { Handler, Json } from './types.ts'

export const HANDLERS: Record<string, Handler> = {
  facts: (args: Json) => facts(args),
  collect: (args: Json) => collect(args),
}
