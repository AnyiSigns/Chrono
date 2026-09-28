// 工具面自述（`todo.describe` 的输出）：单一 `todo` 工具（`action` 分派 replace / update / read）+ 描述四要素 + 工具卡 render 描述符。
// 清单数据只来自 owner 委托存储，服务不读投影。`conversation_id` 不由模型提供，服务从 bag 的当前会话自动解析。
// 状态枚举是单一来源：describe 时从 schema（config.resolveLimits）现读，与写入门禁同源。
// render 形状对齐「工具卡渲染」契约；caps 与 sandbox 同形（无 fs、无 net）。

import { resolveLimits } from './config.ts'
import type { Json, Rec } from 'plugin-sdk'

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

/** 整表条目 schema（`todo.write`）；枚举现读 schema，与写入门禁同源。 */
function itemSchema(statuses: string[]): Rec {
  return {
    type: 'object',
    properties: {
      id: { type: 'string', description: '条目 id（稳定）。整表替换带上从 todo.read 取回的 id 即保持身份；缺省自动分配 t<n>。' },
      text: { type: 'string', minLength: 1, description: '条目正文。' },
      status: { enum: statuses, description: '条目状态；缺省 pending。' },
      activeForm: { type: 'string', description: '进行时描述（如「正在跑测试」），in_progress 时用于展示；可缺省。' },
      at: { type: 'string', description: '该条目的时间（ISO 8601）；缺省沿用本批缺省时间。' },
    },
    required: ['text'],
    additionalProperties: false,
  }
}

/** 增量操作 schema（`todo.update.ops` 的元素）。 */
function opSchema(statuses: string[]): Rec {
  return {
    type: 'object',
    properties: {
      op: { enum: ['add', 'update', 'remove', 'move'], description: '操作名。' },
      id: { type: 'string', description: 'update / remove / move 必填（指向已有条目）；add 不用。' },
      text: { type: 'string', minLength: 1, description: 'add 必填；update 时为新正文。' },
      status: { enum: statuses, description: 'add 缺省 pending；update 为要改成的状态。' },
      activeForm: { type: 'string', description: '进行时描述；update 传空串可清除。' },
      at: { type: 'string', description: '条目时间（ISO 8601）。' },
      index: { type: 'integer', minimum: 0, description: 'move 的目标下标（0 基，越界收敛到末位）。' },
    },
    required: ['op'],
    additionalProperties: false,
  }
}

/**
 * 单一 `todo` 工具（`action` 分派）：replace 整表替换 / update 增量更新 / read 读取。
 * 合并前是 `todo.write` / `todo.update` / `todo.read` 三个工具——三者同 provider、同 caps、同 `detail.kind`，
 * 合成一个可省两份 description / schema / boundaries（模型选择也更简单）。
 */
function todoTool(statuses: string[]): Rec {
  return {
    name: 'todo',
    intent: '维护当前会话的待办清单：整表替换、增量更新或读取。',
    when_to_use:
      '需要给出 / 重排 / 清空完整清单（action=replace）、只改少量条目（action=update）、或查看当前清单（action=read）时。',
    param_semantics: {
      action: '动作：replace 整表替换 / update 增量更新 / read 读取清单。',
      items: 'replace 必填：完整条目数组，整体替换而非增量；传空数组即清空。带 id 的条目保持身份（id 从 action=read 取回），缺省自动分配。',
      ops: 'update 必填：操作数组，按序作用于演进中的清单：{op:"add",text,…} 追加、{op:"update",id,…} 改字段、{op:"remove",id} 删除、{op:"move",id,index} 移到下标。',
      at: '本批条目的缺省时间（ISO 8601）。',
    },
    boundaries:
      '只操作本会话清单：replace 整体替换、update 按 id 增量；同一清单至多一个 in_progress（写入多个回 multiple_in_progress；置某条 in_progress 会把其它降回 pending）；不判定任务是否真完成。',
    description: '维护当前会话的待办清单；返回 {total, done}（update 另回 changed，read 另回 items）。',
    argsSchema: {
      type: 'object',
      properties: {
        action: { enum: ['replace', 'update', 'read'] },
        items: {
          type: 'array',
          items: itemSchema(statuses),
        },
        ops: {
          type: 'array',
          minItems: 1,
          items: opSchema(statuses),
        },
        at: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    caps: NO_CAPS,
    idempotent: false,
    render: TODO_RENDER,
  }
}

/** `describe` 的输出值（工具清单；枚举现读 schema，与门禁同源）。 */
export function describeValue(): Json {
  const statuses = resolveLimits().statuses
  return { tools: [todoTool(statuses)] }
}
