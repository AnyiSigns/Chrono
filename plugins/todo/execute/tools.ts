// 工具面自述（`todo.describe` 的输出）：两个工具 + 描述四要素 + 工具卡 render 描述符。
// `todo.write` / `todo.read` 都走 describe / invoke；清单数据由调用方入口 term 读本插件投影后随 bag 传入
// （bag.todo），服务不自读投影。`conversation_id` 不由模型提供，服务从 bag 的当前会话自动解析。
// render 形状对齐「工具卡渲染」契约；caps 与 sandbox 同形（无 fs、无 net）。

import type { Json, Rec } from './types.ts'

/** 能力声明：对象形 fs + 字符串 net scope（不触盘、不触网）。 */
const NO_CAPS: Rec = {
  fs: { read: 'none', write: 'none' },
  net: 'none',
  timeout_ms: 30000,
  mem_mb: 256,
  output_max: 1048576,
  procs_max: 1,
}

/** 工具卡 render 描述符（card 模板）。 */
const TODO_RENDER: Rec = {
  form: 'card',
  label: 'todo',
  summary: '{done}/{total} 已完成',
  tone: 'plain',
  detail: { kind: 'list', fields: ['text', 'status'] },
}

const ITEM_SCHEMA: Rec = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '条目 id；缺省按会话 id 与下标派生。' },
    text: { type: 'string', minLength: 1, description: '条目正文。' },
    status: {
      enum: ['pending', 'in_progress', 'completed'],
      description: '条目状态；缺省 pending。',
    },
    priority: { type: 'number', description: '可选优先级（数值越小越优先）。' },
    at: { type: 'string', description: '该条目的时间（ISO 8601）；缺省沿用本批缺省时间。' },
  },
  required: ['text'],
  additionalProperties: true,
}

/** 两个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'todo.write',
    intent: '更新当前会话的待办清单，用新清单整体替换旧清单。',
    when_to_use: '需要新增、更新、删除待办项，或把清单整体收尾（全部完成 / 清空）时。',
    param_semantics: {
      items: '完整条目数组，整体替换而非增量；传空数组即清空。',
      at: '本批条目的缺省时间（ISO 8601）。',
      body: '当前清单数据，用于保留其它会话的条目。',
    },
    boundaries: '整体替换、只改本会话；不判定任务是否真完成、不做增量合并。',
    description: '更新当前会话的待办清单：整体替换，返回更新后的清单。',
    argsSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整条目数组；空数组 = 清空本会话清单。',
          items: ITEM_SCHEMA,
        },
        at: { type: 'string', description: '条目缺省时间（ISO 8601）。' },
        body: { type: 'object', description: '当前清单数据，用于保留其它会话的条目。' },
      },
      required: ['items'],
      additionalProperties: true,
    },
    caps: NO_CAPS,
    idempotent: false,
    render: TODO_RENDER,
  },
  {
    name: 'todo.read',
    intent: '读取当前会话的待办清单条目与完成情况。',
    when_to_use: '需要查看当前待办项、完成进度，或在更新前确认现有清单时。',
    param_semantics: {},
    boundaries: '只读，不改清单、不做完成判定。',
    description: '读取当前会话的待办清单，返回 {items, total, done}。',
    argsSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    caps: NO_CAPS,
    idempotent: true,
    render: TODO_RENDER,
  },
]

/** `describe` 的输出值（工具清单；模型可见文本由四要素拼装，这里直给 description）。 */
export function describeValue(): Json {
  return { tools: TOOLS }
}
