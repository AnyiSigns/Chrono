// 工具面自述（`orchestration-admin.describe` 的输出）：四个工具 + 描述四要素 + 工具卡 render 描述符。
// 工具名命名空间化 `orchestration.*`（否则裸 read / write 与其它工具撞名，破「工具名全局唯一」）；
// render 按「渲染」表：四个工具都 `solid`，propose 展开看 diff。

import type { Json, Rec } from './types.ts'

/** 能力声明（与 #25 一致：`{fs:{read,write}, net}` 对象形、含 fs.read；net 为字符串 scope）。 */
const READONLY_CAPS: Rec = {
  fs: { read: 'none', write: 'none' },
  net: 'none',
  timeout_ms: 30000,
  mem_mb: 256,
  output_max: 2097152,
  procs_max: 1,
}

const GRAPH_BAG: Rec = { type: 'object', description: '当前编排图数据。' }
const EVOLUTION_BAG: Rec = { type: 'object', description: '变更台账（可选）。' }
const PINS_BAG: Rec = { type: 'object', description: '依赖关系表（名 → 被依赖的插件名）。' }

/** 四个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'orchestration.list',
    intent: '列出当前生效编排图的概览、契约清单与阈值。',
    when_to_use: '需要总览当前编排有哪些节点、契约与阈值时。',
    param_semantics: {
      graph: '当前编排图数据。',
      evolution: '变更台账（可选，用于关联证据摘要）。',
      pins: '依赖关系表。',
    },
    boundaries: '只读概览，不含全文；看全文用 orchestration.read，校验用 orchestration.validate。',
    description: '列出当前编排图的概览、契约清单与阈值。',
    argsSchema: { type: 'object', properties: { graph: GRAPH_BAG, evolution: EVOLUTION_BAG, pins: PINS_BAG }, additionalProperties: true },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'orchestration', summary: 'list', tone: 'solid', detail: { kind: 'list' } },
  },
  {
    name: 'orchestration.read',
    intent: '读取编排某一部分的全文（契约 / 节点 / 图 / 阈值 / 证据）。',
    when_to_use: '需要查看某契约、某个节点、整张图或阈值明细时。',
    param_semantics: {
      kind: '要读的类型：contract / scope / graph / thresholds / evidence。',
      target: '目标 id；kind=graph 时忽略。',
      graph: '当前编排图数据。',
    },
    boundaries: '只读单条目，不列目录；校验用 orchestration.validate，改图用 orchestration.propose。',
    description: '按类型与 id 读取编排某一部分的全文。',
    argsSchema: {
      type: 'object',
      properties: {
        kind: { enum: ['contract', 'scope', 'graph', 'thresholds', 'evidence'] },
        target: { type: 'string', description: '条目 id。' },
        graph: GRAPH_BAG,
        evolution: EVOLUTION_BAG,
      },
      required: ['kind', 'target'],
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'orchestration', summary: 'read  {target}', tone: 'solid', detail: { kind: 'json' } },
  },
  {
    name: 'orchestration.validate',
    intent: '预校验一份候选编排图，返回错误列表与校验结果。',
    when_to_use: '准备提交编排变更之前，先校验候选图是否合法。',
    param_semantics: {
      graph: '待校验的候选编排图。',
      active_graph: '当前生效图，用于对比。',
      pins: '依赖关系表。',
      runs_since_fork: '距上次分叉的回合数。',
    },
    boundaries: '只是预检，不代表已生效；不改动编排。',
    description: '校验候选编排图，返回 {ok, errors, result_hash}。',
    argsSchema: {
      type: 'object',
      properties: {
        graph: GRAPH_BAG,
        active_graph: { type: 'object', description: '当前生效图。' },
        pins: PINS_BAG,
        runs_since_fork: { type: 'integer', minimum: 0 },
      },
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'orchestration', summary: 'validate  {target}', tone: 'solid', detail: { kind: 'json' } },
  },
  {
    name: 'orchestration.propose',
    intent: '提交一次编排变更提案，交用户或自动流程采纳。',
    when_to_use: '候选图已通过 orchestration.validate、且有支撑依据时。',
    param_semantics: {
      class: '变更类型：binding / instance_growth / structure / fold。',
      evidence_ids: '支撑依据 id 列表，必填非空。',
      graph: '候选编排图。',
      writes: '随附的附加改动（可为空）。',
      target: '变更目标；缺省取当前生效图。',
      by: '提案来源：evolve-loop（缺省）/ user。',
      validate_hash: '上次 orchestration.validate 的结果哈希，必填。',
    },
    boundaries: '只产提案，不直接改图；采纳由用户或自动流程决定。',
    description: '提交编排变更提案。',
    argsSchema: {
      type: 'object',
      properties: {
        class: { enum: ['binding', 'instance_growth', 'structure', 'fold'] },
        evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        graph: GRAPH_BAG,
        writes: { type: 'array', items: { type: 'object' } },
        target: { type: 'object' },
        by: { enum: ['evolve-loop', 'user'] },
        validate_hash: { type: 'string', description: '上次 orchestration.validate 的结果哈希。' },
      },
      required: ['class', 'evidence_ids', 'graph'],
      additionalProperties: true,
    },
    caps: READONLY_CAPS,
    idempotent: false,
    render: { form: 'card', label: 'orchestration', summary: 'propose  {target}', tone: 'solid', detail: { kind: 'diff' } },
  },
]

/** `describe` 的输出值（工具清单；模型可见文本由四要素拼装，这里直给 description）。 */
export function describeValue(): Json {
  return { tools: TOOLS }
}
