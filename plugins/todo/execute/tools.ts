// 工具面自述（`todo.describe` 的输出）：两个工具 + 描述四要素 + 工具卡 render 描述符。
// `todo.write` 走 describe / invoke；`todo.read` 是能力类工具绑定、method 缺省 = 投影读
// （清单数据由调用方入口 term 读本插件投影后随 bag 传入，本服务不自读投影），故带 binding 标记。
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
    id: { type: 'string', description: '条目 id；缺省由服务按 会话 id + 下标 派生。' },
    text: { type: 'string', minLength: 1, description: '条目正文。' },
    status: {
      enum: ['pending', 'in_progress', 'completed'],
      description: '条目状态；缺省 pending。',
    },
    priority: { type: 'number', description: '可选优先级（数值越小越优先，语义归调用方）。' },
    at: { type: 'string', description: '该条目的时间（ISO 8601）；缺省继承 args.at。' },
  },
  required: ['text'],
  additionalProperties: true,
}

/** 两个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'todo.write',
    intent: '整表替换当前会话的待办清单，把清单持久化进世界（每条一次可回放的世界写）。',
    when_to_use:
      '需要新增 / 更新 / 删除待办项，或把清单显式收尾（全部 completed / 清空）以便图收口时。',
    param_semantics: {
      conversation_id:
        '目标会话 id（由调用方入口 term 读 session 投影的 current 后传入）；只改这个会话键。',
      items: '完整条目数组（整表替换，不是增量）；传空数组即清空本会话清单。',
      at: '本批条目的缺省时间（调用方入口 term 由帧 env.now 提供）；服务不取时间。',
      body: '当前待办 body（调用方入口 term 读本插件投影后传入），用于保留其它会话键。',
    },
    boundaries:
      '整表替换、只改本会话键；不判定任务是否真做完、不写其它身份、不长期保存知识；不做增量合并。',
    description:
      '整表替换当前会话的待办清单：产出 新条目 defs（prev 串成新链）+ 本会话键的新 body + add_gen 的原子写计划。',
    argsSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', minLength: 1, description: '目标会话 id。' },
        items: {
          type: 'array',
          description: '完整条目数组；空数组 = 清空本会话清单。',
          items: ITEM_SCHEMA,
        },
        at: { type: 'string', description: '条目缺省时间（ISO 8601）；服务不取时间。' },
        body: { type: 'object', description: '当前待办 body，用于保留其它会话键。' },
      },
      required: ['conversation_id', 'items'],
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
    param_semantics: {
      conversation_id: '目标会话 id（由调用方入口 term 读 session 投影的 current 后传入）。',
    },
    boundaries:
      '只读、幂等；本服务不读投影，清单数据由调用方入口 term 随 bag 传入；不做完成判定、不写世界。',
    description:
      '从调用方传入的本插件投影数据里解析目标会话的条目链，返回 {items, total, done}。',
    argsSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', minLength: 1, description: '目标会话 id。' },
      },
      required: ['conversation_id'],
      additionalProperties: true,
    },
    caps: NO_CAPS,
    idempotent: true,
    render: TODO_RENDER,
    binding: { class: 'todo', method: null },
  },
]

/** `describe` 的输出值（工具清单；模型可见文本由四要素拼装，这里直给 description）。 */
export function describeValue(): Json {
  return { tools: TOOLS }
}
