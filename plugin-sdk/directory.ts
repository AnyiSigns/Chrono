// 工具目录索引的纯单源：把 `{tools, rejected}` 形态的目录结果重建为按名索引的目录。
// `tool-registry`（目录语义拥有方）与 `tool-dispatch`（派发消费方）共同引用，避免两份逐字节拷贝。
// 纯函数，零内核零宿主依赖。

import type { Json, Rec } from './json.ts'
import { isRecord } from './json.ts'

/** 不合规工具条目的诊断。 */
export interface Rejection {
  name: string
  code: string
  message: string
}

/** 目录条目：工具名 + 派发所需的 provider / kind / method / read 与完整声明。 */
export interface ToolEntry {
  name: string
  /** 派发用的逻辑端口名（describe/invoke 提供者 = 其类名；绑定项 = 绑定声明的 class）。 */
  provider: string
  kind: 'invoke' | 'binding'
  /** 绑定项的能力类方法；`null` = 投影读（无服务调用）。 */
  method: string | null
  /** 投影读的 bag 键（缺省 = 工具名）。 */
  read: string | null
  /** 对外暴露的完整声明（含 provider / kind，供调用方渲染与派发）。 */
  decl: Rec
}

/** 按名索引的工具目录。 */
export interface Directory {
  tools: ToolEntry[]
  byName: Map<string, ToolEntry>
  rejected: Rejection[]
}

/** 从 list 的输出（或 bag.directory）重建目录：按名索引，保留 provider / kind / method / read。 */
export function indexToolDirectory(json: Json): Directory {
  const record = isRecord(json) ? json : {}
  const rawTools = Array.isArray(record['tools']) ? (record['tools'] as Json[]) : []
  const rejected = Array.isArray(record['rejected'])
    ? (record['rejected'] as Json[]).filter(isRecord).map((item) => ({
        name: typeof item['name'] === 'string' ? (item['name'] as string) : '',
        code: typeof item['code'] === 'string' ? (item['code'] as string) : 'bad_tool_decl',
        message: typeof item['message'] === 'string' ? (item['message'] as string) : '',
      }))
    : []
  const tools: ToolEntry[] = []
  for (const raw of rawTools) {
    if (!isRecord(raw)) continue
    const name = raw['name']
    if (typeof name !== 'string' || name.length === 0) continue
    const kind = raw['kind'] === 'binding' ? 'binding' : 'invoke'
    const provider = typeof raw['provider'] === 'string' ? (raw['provider'] as string) : ''
    const method = typeof raw['method'] === 'string' ? (raw['method'] as string) : null
    const read = typeof raw['read'] === 'string' ? (raw['read'] as string) : null
    tools.push({ name, provider, kind, method, read, decl: raw })
  }
  return { tools, byName: new Map(tools.map((entry) => [entry.name, entry])), rejected }
}
