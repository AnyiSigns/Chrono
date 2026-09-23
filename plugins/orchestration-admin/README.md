# orchestration-admin（agent 面编排管理）

agent 面编排管理的**唯一**路径：列图 / 读条目 / 跑机械闸 dry-run / 产提案。
**只产提案条目，不产证据、不产写**——它把一次编排变更落成可审计的提案，交 loop-policy 的
「提案扫描与采纳」消费；人闸在采纳，不在本插件。

- 能力类：`orchestration`（`list` / `read` / `validate` / `propose`）+ `orchestration-admin`（`describe` / `invoke`）。
- `pins`：`{}` —— **无 pins、不 pin loop-policy**（loop-policy 只有 `interpret`，不提供 `validate`；本插件的校验是本地复刻 dry-run）。
- 工具名：`orchestration.list` / `orchestration.read` / `orchestration.validate` / `orchestration.propose`（命名空间化，避免与其它工具撞名）。
- 输入来源：图六类条目、台账与 `ids.loop-policy.pins` **由调用方（loop-policy 装配）随 bag / args 传入**；服务不读投影。
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 分签红线（结构性）

本插件**只产提案、不产证据**；`evolve-metrics` **只产证据、不产提案**。两层用 `evidence_id` 连接。
给本插件加产证据的能力就等于「自己造证据支持自己的提案」，评审再也无法机械验证。
用户请求也算证据：由调用方先经 `evolve-metrics.record` 落一条 `class:'user_request'` 证据，再引用它
（生产者不是本插件）。

## bag 形状（由 loop-policy 装配传入）

```jsonc
{
  "graph": {                       // 六类条目包装（list / read / validate / propose 共用）
    "contracts": [ … ],            // 契约
    "nodes": [ … ],                // Scope 实例
    "prompts": [ … ],              // 提示词
    "graph": { … },                // 唯一顶层图（validate / propose 时 = 待校验 / 候选图）
    "thresholds": { … },           // 阈值（名 → 值；也接受 [{name,value}] / {entries:[…]}）
    "refusal_codes": [ … ]
  },
  "pins": { "<逻辑端点名>": "<被依赖身份名>" },   // 投影 ids.loop-policy.pins
  "active_graph": { … } | null,    // 当前 active 图（fork 基；用于 fork-only 与 diff 上限）
  "runs_since_fork": 0 | null,     // 距上次 fork 的回合数（min_runs_before_fork）
  "evolution": { … },              // 进化台账（trace / evidence / proposals / verdicts）
  "now": 0, "run": "…",            // 时钟与回合（服务不取时间、不用随机）
  // propose 专用：
  "class": "structure", "evidence_ids": ["ev-…"], "writes": [ … ], "target": { … },
  "by": "evolve-loop", "validate_hash": "<64-hex>", "run_proposal_count": 0
}
```

## `orchestration.validate`：本地复刻机械闸 dry-run

对 bag 跑与 loop-policy 写期机械闸同口径的检查，返回 `{ok, errors:[{code, path, message}], result_hash}`。
**不 eff loop-policy**（只读 bag + 本地复刻同一套逻辑）。

机械闸规则清单（来源：loop-policy 设计「图与六条不变量」「演化口径」）：

| 组 | 规则 | 错误码 |
| --- | --- | --- |
| 闭合 | 节点非空 / 边引用在界内 / 无环 / sink 合法 / 非首节点有入边 / 每节点可达 sink / sink 唯一 / required 入边全连 | `no_nodes` / `edge_ref` / `cycle` / `sink` / `non_entry_isolated` / `no_path_to_sink` / `multiple_sinks` / `unconnected_input` |
| 类型 | 边两端端口存在、名义类型兼容 | `unknown_port` / `type_mismatch` |
| publish 偏序 | 同 SharedRef 发布者两两有拓扑偏序（保守拒） | `publish_order` |
| 端口 ⊆ pins | 契约 `effects.ports` 与 atomic 节点 `entry.cap` 都在 pins 里 | `port_not_pinned` |
| 不变量 1 | 池中保留一个只依赖 `entry_supply` 的 `touches_effects:false` 契约 | `missing_fallback_entry` |
| 不变量 2 / 3 | `join` / `subagent` 契约必在 | `missing_join_contract` / `missing_subagent_contract` |
| 不变量 4 | 声明高危端口的 Scope 可达路径上有 `guard → approval` 段 | `approval_bypass` |
| 不变量 5 | 任一路径连续 LLM Scope 数 ≤ `thresholds.llm_chain_max`（composite 按子图最长链折算） | `llm_chain_max` |
| 不变量 6 | 图内出现的每个契约至少有一个 `scope:global` 实例 | `last_global_instance` / `unknown_contract` |
| 演化 1 | fork-only：新图带 `derived_from`（有 active 时须等于其哈希），禁空白整图 | `fork_only` |
| 演化 2 | 结构改动 ≤ `thresholds.max_graph_diff`（节点逐位差 + 边集合对称差） | `diff_exceeded` |
| 演化 3 | `runs_since_fork ≥ thresholds.min_runs_before_fork` | `min_runs_before_fork` |

### 结果哈希口径

```text
result_hash = H({ graph, pins, active_graph, runs_since_fork })
```

- `H` = `sha256(utf8(canonicalJson(v)))`（对象键升序、剔 `undefined`、`-0 → 0`）。
- 同一 bag → 同一哈希；`propose` 用同一口径重算并机械比对调用方带回的 `validate_hash`。

### 已知实现重复（明写）

`validate` 是**本地复刻** loop-policy 机械闸的 dry-run，**已知实现重复**（与附件校验重复同性质：白名单 schema
无 `$ref`、无法共享）。**权威以 loop-policy 写期机械闸为准**；`validate` 只是预检、**不构成门禁证据**
（权威闸 = loop-policy 写期机械闸 + `evolve-metrics` shadow + 审批人闸）。
**副本一致性对拍（2026-09-21 已完成）**：loop-policy 已落地，`plugins/loop-policy/test/parity.test.mjs`
对同一 bag 同时跑本副本 `validateBag` 与权威 `validateGraphData`，逐项断言 **规则清单 / 错误码 / 结果哈希**
一致（4 组样例：种子图缺 derived_from、合法 fork、高危无审批段、缺 join + 端口未 pin）。对拍发现并修正一处口径：
不变量 4 的写档 fs 判据改为**声明式**（显式声明 `caps.fs.write` 非 `'none'` 才算高危），并在 `effects.ports`
之外也据 `caps.fs.write` 判定（`tool.dispatch` 端口为 `tools` 但写档 ⇒ 高危，与 loop-policy 契约一致）。
本副本仍为预检、不构成门禁证据；规则换代以 loop-policy 为准。

## `orchestration.propose`：只产提案条目

四条硬约束（写期机械校验，不满足直接拒）：

1. **`evidence_ids` 必填非空** —— 无证据提案直接拒（`evidence_required`）。用户请求也须先经 `evolve-metrics.record` 落证据。
2. **fork-only** —— 候选图必须带 `derived_from`（当前 active 图哈希）、禁空白整图（`fork_required`）。
3. **`validate` 前置** —— 必须携带同一 bag 的上次 `validate` 结果哈希，缺失 / 不符拒 `validate_required`；图不过机械闸拒 `invalid_graph`。
4. **额度** —— 提案条数受 schema `max_proposals_per_run`（`quota_exceeded`）；diff 上限是 `validate` 的演化规则 2（机械闸），已由第 3 条前置强制。用户显式请求（`by:"user"`）不占条数额度，但机械闸照跑。

`propose` 的计划形状（批内 `{"$n":k}` 只指向更早的 `put`）：

```text
put(候选图 def)                     # graph.graph
put(writes[].payload def) × n       # 跨身份附加写的 payload（可为空）
put(proposal 条目)                  # kind:"proposal"，patch = {def:图哈希, graph:{def}, writes:[{identity,payload:{def}}]}
put(新 evolution body)              # proposals.tail 指向新提案、count+1，其余三链原样带回
add_gen(evolution)                  # 只对台账身份 add_gen；跨身份写由采纳阶段展开
```

- **不产证据**：输出里只有 `kind:'proposal'` 条目，没有 `kind:'evidence'`。
- **不直接写图**：不产 `add_gen(loop-policy)`；`patch.graph` / `patch.writes[]` 的 def 先落，供采纳阶段
  （loop-policy 提案扫描）展开成一条原子 `batch` 交宿主落账。
- **跨身份采纳**：`writes[] = [{identity, payload:{def}}]`；采纳不是只对图 `add_gen`，而是一次多身份批量写，
  由采纳者在图外一次性提交、审批闸对整批生效（不出现「图改了、人格 / 技能没写」的半采纳）。
- **确定性**：不取时间、不用随机；`now` / `run` 由 bag 传，提案 id = `pr-<run>-<序号>`。

## 工具面（`orchestration-admin.describe`）

四个工具各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）与工具卡
`render` 描述符；`orchestration-admin.invoke {tool, args}` 按工具名派发到 `orchestration.*`，
业务失败回 `{ok:false,error:{code,message}}`。

| 工具 | `form` | `label` | `summary` | `tone` | `detail.kind` | `idempotent` |
| --- | --- | --- | --- | --- | --- | --- |
| `orchestration.list` | `card` | `orchestration` | `list` | `solid` | `list` | true |
| `orchestration.read` | `card` | `orchestration` | `read  {target}` | `solid` | `json` | true |
| `orchestration.validate` | `card` | `orchestration` | `validate  {target}` | `solid` | `json` | true |
| `orchestration.propose` | `card` | `orchestration` | `propose  {target}` | `solid` | `diff` | false |

- 高危写类用 `solid`：默认收缩显示 `op + target`，展开看图 diff 与影子回放指标对比。
- `caps` 含 `fs.read`，`net` 为字符串 scope（`"none"`）。

## 结构化错误码

`evidence_required`（缺证据）、`fork_required`（非 fork-only / 空白整图）、`validate_required`（缺 / 不符 validate 哈希）、
`invalid_graph`（图不过机械闸）、`quota_exceeded`（提案条数额度）、`proposal_too_large`（提案大小上限）、
`bad_change_class`（变更类不在允许集）、`bad_write`（writes 形状非法）、`unknown_tool`（invoke 未知工具）、
`bad_args`（args 形态非法）、`graph_missing` / `not_found` / `bad_kind`（读面）、机械闸各码见上表。

## schema

`schema/orchestration-admin.json` 只声明**私有参数**：`allowed_classes`（允许的变更类）、
`max_proposals_per_run`（提案条数上限）、`max_proposal_bytes`（提案大小上限）。
**diff 上限读 loop-policy `thresholds`，不在本 schema 重定义**。

## 已知限制 / 偏离（明写）

- **机械闸副本对拍为待办**：见上「已知实现重复」。
- **不变量 4 按端口 + caps 粒度近似**：真实判据 = `(port=提供者能力类名, 工具名)`（与 guard / tools 口径对齐）；
  图数据里只有端口名与 `caps`，故本副本按 `exec` / `plugin-admin` / `orchestration-admin` 端口名，
  外加**声明式写档**（`caps.fs.write` 非 `'none'`）机械判定，并以 `guard → approval` 直边 + 双向可达近似
  「可达路径上存在该段」（composite 同样递归生效）。更精确的 (port, tool) 判据归 loop-policy 运行时。
- **不变量 6 只查图内出现的契约**：契约池里声明但未实例化的契约（如待插的 `recall`）不要求 global 实例。
- **类型兼容为名义判定**：六类条目无独立 `type_id` 表，故只做相等 / 通配（`any` / `*`）判定，不展开 `subtypes`。
- **diff 上限在 `validate` 强制**：`propose` 的第 4 条额度只判提案条数（diff 由 `validate` 演化规则 2 覆盖）。
- **`run_proposal_count` 由调用方装配**：本插件不自读台账计数（服务不读投影）。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack/seed → start → loaded → stop → verify → replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
