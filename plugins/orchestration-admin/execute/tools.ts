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

const GRAPH_BAG: Rec = { type: 'object', description: '图六类条目包装（由 #33 装配随 bag 传入）。' }
const EVOLUTION_BAG: Rec = { type: 'object', description: '#43 台账（trace / evidence / proposals / verdicts）。' }
const PINS_BAG: Rec = { type: 'object', description: '投影 ids.loop-policy.pins（名 → 被依赖身份名）。' }

/** 四个工具的自述（name / 四要素 / argsSchema / caps / idempotent / render）。 */
export const TOOLS: Json[] = [
  {
    name: 'orchestration.list',
    intent: '列出当前 active 图的 Scope 概览、契约清单与阈值表。',
    when_to_use: '在决定读 / 改哪一处编排之前，先看清图里有哪些 Scope、契约与阈值。',
    param_semantics: {
      graph: '图六类条目包装（contracts / nodes / prompts / graph / thresholds / refusal_codes）。',
      evolution: '#43 台账（可选，用于关联证据摘要）。',
      pins: '投影 ids.loop-policy.pins；名 → 被依赖身份名。',
    },
    boundaries: '只读概览，不含条目全文；看全文用 orchestration.read，跑校验用 orchestration.validate。',
    description: '列出 Scope 概览（node_index / contract_id / impl / scope / autonomy / links）+ 契约清单 + 阈值表。',
    argsSchema: { type: 'object', properties: { graph: GRAPH_BAG, evolution: EVOLUTION_BAG, pins: PINS_BAG }, additionalProperties: true },
    caps: READONLY_CAPS,
    idempotent: true,
    render: { form: 'card', label: 'orchestration', summary: 'list', tone: 'solid', detail: { kind: 'list' } },
  },
  {
    name: 'orchestration.read',
    intent: '读取某条目全文（契约 / Scope / 图 / 阈值 / 证据）与关联证据摘要。',
    when_to_use: '需要查看某契约、某个 Scope 实例、整张图或阈值明细时。',
    param_semantics: {
      kind: '条目类型：contract / scope / graph / thresholds / evidence。',
      target: '条目 id：契约 id / node_id / 阈值名 / evidence id；kind=graph 时忽略。',
      graph: '图六类条目包装（由 #33 装配随 bag 传入）。',
    },
    boundaries: '只读单条目，不列目录；不跑机械闸（用 orchestration.validate）、不改图（用 orchestration.propose）。',
    description: '按 kind + target 读某条目全文，附关联证据摘要。',
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
    intent: '本地复刻 #33 机械闸 dry-run，返回错误列表与结果哈希（不 eff #33）。',
    when_to_use: '准备提编排变更之前，先机械校验候选图是否过闭合 / 类型 / 偏序 / 端口 / 六不变量 / 四规则。',
    param_semantics: {
      graph: '待校验的图六类条目（graph.graph 为候选图）。',
      active_graph: '当前 active 图 body（fork 基；用于 fork-only 与 diff 上限）。',
      pins: '投影 ids.loop-policy.pins（判端口 ⊆ pins）。',
      runs_since_fork: '距上次 fork 的回合数（判 min_runs_before_fork）。',
    },
    boundaries: '只是预检、不构成门禁证据（权威闸 = #33 写期机械闸 + #44 shadow + #32 人闸）；不改世界。',
    description: '跑闭合 / 类型 / publish 偏序 / 端口 ⊆ pins + 六条图不变量 + 四条演化规则，回 {ok, errors, result_hash}。',
    argsSchema: {
      type: 'object',
      properties: {
        graph: GRAPH_BAG,
        active_graph: { type: 'object', description: '当前 active 图 body。' },
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
    intent: '把一次编排变更落成可审计的提案条目写计划（只产提案，不产证据、不产写）。',
    when_to_use: '已有证据支撑、且候选图已过 orchestration.validate 时，产一条 fork-only 提案交 #33 采纳阶段。',
    param_semantics: {
      class: '变更类：binding / instance_growth / structure / fold。',
      evidence_ids: '支撑证据 id 列表，必填非空（用户请求也须先经 #44 record 落证据）。',
      graph: '候选图六类条目（graph.graph 为候选图，必须带 derived_from）。',
      writes: '跨身份附加写（[{identity, payload}]，可为空）；payload def 先落，采纳阶段才 add_gen。',
      target: '变更目标 {graph:{def}|null, contract_id, node_id}；缺省取当前 active 图。',
      by: '提案来源：evolve-loop（缺省）/ user（用户显式请求，不占额度）。',
      validate_hash: '上次 orchestration.validate 的结果哈希（同一 bag / 同一 patch），必填。',
    },
    boundaries: '只产提案条目、不产证据、不直接写图、不入人闸（人闸在采纳）；不满足四硬约束直接拒。',
    description: '产 put(候选图 def)+put(writes[].payload def)+put(提案)+put(新 evolution body)+add_gen(evolution) 的原子写计划。',
    argsSchema: {
      type: 'object',
      properties: {
        class: { enum: ['binding', 'instance_growth', 'structure', 'fold'] },
        evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        graph: GRAPH_BAG,
        writes: { type: 'array', items: { type: 'object' } },
        target: { type: 'object' },
        by: { enum: ['evolve-loop', 'user'] },
        validate_hash: { type: 'string', description: '上次 validate 的结果哈希（64 位小写 hex）。' },
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
