// 能力类 `router` 的方法表：唯一方法 select 是纯判定（见 select.ts）。
// 服务不读投影、不自取时钟；候选端口名清单 / 失败码 / 别名清单全由调用方随 args 传入。

import { DEFAULT_ALIASES, DEFAULT_ALIAS_PRIMARY } from './plugin.ts'
import { parseSelect, select } from './select.ts'
import type { Handler, Json } from './types.ts'

const DEFAULTS = { primary: DEFAULT_ALIAS_PRIMARY, aliases: DEFAULT_ALIASES }

export const HANDLERS: Record<string, Handler> = {
  select: (args: Json): Json => select(parseSelect(args, DEFAULTS)),
}
