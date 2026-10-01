// 能力类 `tool-registry` 的方法表：`list`（出工具目录）+ `validate-args`（按同一方言校验模型 args）。
// 目录所需绑定表 / MCP 清单由调用方随 bag 传入；describe 提供者经反向 `port.call`（服务不读投影、无写通道）。
// argsSchema 白名单校验 / 净化与 caps 形状校验是纯函数，住同包 `schema-validate.ts`，不再跨插件调用。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { listDirectory, type SchemaBackend } from './directory.ts'
import { normalizeCaps, sanitizeArgsSchema, validateArgs, validateArgsSchema } from './schema-validate.ts'
import type { Handler, HandlerResult, Json, PortLink, Rec } from 'plugin-sdk'

export interface RegistryDeps {
  link: PortLink
  /** 有效 pins（声明 `pins` ∪ `one`-needs 绑定）的逻辑端口名；绑定工具的 class 校验来源。 */
  pins: string[]
  /** 扩展类 `tool-provider` 的世界成员（提供方身份名，码元序）；宿主按世界注入。 */
  manyProviders: string[]
}

/** 本地 schema 后端：直接调同包纯函数（无反向调用、无超时嵌套）。 */
export const LOCAL_SCHEMA: SchemaBackend = {
  async normalizeDecl(schema: Json | undefined, lenient: boolean) {
    if (lenient) {
      return { ok: true, message: '', schema: sanitizeArgsSchema(schema ?? { type: 'object' }) }
    }
    const result = validateArgsSchema(schema)
    return { ok: result.ok, message: result.message, schema: result.ok ? (schema ?? null) : null }
  },
  async normalizeCaps(caps: Json | undefined, lenient: boolean) {
    const result = normalizeCaps(caps, lenient)
    return { ok: result.ok, message: result.message, caps: result.caps }
  },
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
    schema: LOCAL_SCHEMA,
  })
  return {
    tools: directory.tools.map((entry) => entry.decl) as unknown as Json,
    rejected: directory.rejected as unknown as Json,
  }
}

/** `validate-args({schema, value})`：按白名单方言校验模型 args。 */
function validateArgsOf(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const result = validateArgs(args['schema'], args['value'])
  return { ok: result.ok, message: result.message }
}

/** 构造方法表（main.ts 校验 `port` / `method` 后取用）。 */
export function createHandlers(deps: RegistryDeps): Record<string, Handler> {
  return {
    list: async (args: Json): Promise<HandlerResult> => ({
      value: await listTool(args, deps),
      events: [],
    }),
    'validate-args': (args: Json): HandlerResult => ({ value: validateArgsOf(args), events: [] }),
  }
}
