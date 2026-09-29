// 能力类 `tool-registry` 的方法表：`list`（出工具目录）。
// 目录所需绑定表 / MCP 清单由调用方随 bag 传入；describe 提供者与 argsSchema / caps 校验
// 分别经反向 `port.call` 到工具提供者与 `tool-schema`（服务不读投影、无写通道）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { listDirectory } from './directory.ts'
import { RemoteToolSchema } from './port-link.ts'
import type { Handler, HandlerResult, Json, PortLink, Rec } from 'plugin-sdk'

export interface RegistryDeps {
  link: PortLink
  /** 有效 pins（声明 `pins` ∪ `one`-needs 绑定）的逻辑端口名；绑定工具的 class 校验来源。 */
  pins: string[]
  /** 扩展类 `tool-provider` 的世界成员（提供方身份名，码元序）；宿主按世界注入。 */
  manyProviders: string[]
}

/** `list(bag)`：出工具目录 = 扩展类世界成员 describe 并集 + 绑定表 + 外部 MCP 工具（校验 / 去重后）。 */
async function listTool(args: Json, deps: RegistryDeps): Promise<Json> {
  if (args !== undefined && args !== null && !isRecord(args))
    throw new BadArgsError('bag must be an object')
  const bag: Rec = isRecord(args) ? args : {}
  const directory = await listDirectory({
    pins: deps.pins,
    manyProviders: deps.manyProviders,
    bag,
    link: deps.link,
    schema: new RemoteToolSchema(deps.link),
  })
  return {
    tools: directory.tools.map((entry) => entry.decl) as unknown as Json,
    rejected: directory.rejected as unknown as Json,
  }
}

/** 构造方法表（main.ts 校验 `port` / `method` 后取用）。 */
export function createHandlers(deps: RegistryDeps): Record<string, Handler> {
  return {
    list: async (args: Json): Promise<HandlerResult> => ({
      value: await listTool(args, deps),
      events: [],
    }),
  }
}
