# #43 `evolution`（进化台账数据身份）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 43 / `evolution` |
| 职责 | 自进化环的**唯一落点**：`trace`（回合尾轨迹摘要）/ `evidence`（证据）/ `proposals`（提案）/ `verdicts`（采纳与拒绝判定）四类索引，各自成 def + **链式 tail** |
| 依赖 | pins 无；`<-` 33（投影读 + 写回计划）、44（投影读轨迹 + 写回证据计划）、45（投影读 + 写回提案计划）、17（S13 台账只读） |
| 成员 | schema（**纯数据身份**：无 execute、无 terms、无命令、无进程、无端口） |
| 能力类·方法 / 命令 | 无 |
| schema | `schema/evolution.json` |
| 机制 | 见下 |
| 边界 | 不做：聚合与判定（归 44）/ 提案（归 45）/ 门禁与采纳（归 33 + 32）/ 渲染（归 17）/ 起进程 |
| 验收 | 1) 加一条轨迹 = 1 条目 def + 1 索引 def，**不重写全量**；2) 四类形状固定、可回放；3) 从 `verdict` 可反查 `proposal_id` → `evidence_id` → `trace` → `eff_log`（**全链可溯源**）（2026-09-20 修订）；4) **拒绝的判定也在 tail 里**（只记采纳 = 环不可审计）；5) 纯数据身份：无进程、无端口；6) 世界增长 ∝ 回合数（轨迹只存摘要 + 引用） |
| 状态 | 新增（2026-09-19，agent 图与自进化）：完整设计见 `docs/plans/agent-graph-design.md` |

> **为什么四类合成一个身份**：轨迹高频可清理、证据 / 提案 / 判定低频要永久，生命周期不同；
> 但 `Identity.schema` 在**身份诞生时固定**、改数据契约须 `fork`（`host.md` §源码），一次定齐四类即可；
> 且"证据可溯源到轨迹"在**同一身份内** `refs` 闭包就能解，拆两个身份反而要跨身份引用。省一个身份。

---

## 数据契约 `schema/evolution.json`

```jsonc
// body（小、可回放）：四条链头，不列全部条目
{ "version": 1,
  "trace":     { "tail": {"def":"…"} | null, "count": 0 },
  "evidence":  { "tail": {"def":"…"} | null, "count": 0 },
  "proposals": { "tail": {"def":"…"} | null, "count": 0 },
  "verdicts":  { "tail": {"def":"…"} | null, "count": 0 } }
```

四类条目**各自成 def、带 `prev` 成链**（同 #11 / #21 / #35）；写一次 = `put(条目) + put(新 body) + add_gen`；
条目 body 由**宿主投影引用闭包解析**放进 `ids.evolution.refs`（复用已登记的宿主能力）。

### `trace` 条目（回合尾一次写）

```jsonc
{ "kind": "trace", "run": "…", "session": "c1", "workspace_id": "w1",
  "graph": "<当时 active 图的 def 哈希>",
  "steps": [
    { "node_index": 1, "iter": 1, "contract_id": "agent.step",
      "chosen_instance": "nd-…", "chosen_agent": "ag-…" | null,
      "verdict": "pass" | "fail", "refusal": null | "capability_mismatch",
      "post_failed": null | "malformed_tool_call",   // verdict=fail 的原因（post_failure 证据来源）
      "l1_iters": 3, "l1_maxed": false,          // L1 自治：迭代次数 + 是否打满（no_progress 证据来源）
      "verify": { "passed": true, "skipped": false } | null,  // 仅 verify 节点：近 oracle 信号（verify_failure 来源）
      "usage": { "tokens": 0, "calls": 1, "tool_calls": 0, "walltime_ms": 0 },
      "eff_log": [ { "step": 0, "iter": 1, "port": "model", "method": "chat", "args_hash": "…", "result_hash": "…", "outcome": "ok" } ] } ],  // 每步记录、interpret 内收集、回合尾随 trace 写入——**post dense 信号与 shadow 配对的底座**（2026-09-20 定案）
  "directives_summary": { "def": "<本次 run directives 摘要哈希>" } | null,  // 影子回放数据载体（v1 闭环，见下）
  "ctx_summary": { "def": "<轮首投影 ctx 摘要哈希>" } | null,                // 影子回放数据载体
  "refused_at": { "node_index": 2, "iter": 1, "code": "denied", "attributable_to": "user" } | null,
  "branch_not_taken": 3,                          // 未触发分支的聚合计数（0 计费）
  "link_taken": [ { "from": 1, "to_contract": "clarify", "reason": "…" } ],
  "outcome": "done" | "refused" | "idle" | "cancelled",   // 内核四态（同 run.finished.status）
  "at": "…", "prev": { "def": "…" } | null }
```

- **只存摘要 + 引用，正文不重复存**（正文已在 `eff_log` / 世界数据里）⇒ 世界增长 ∝ 回合数（验收 6）。
- **`directives_summary` / `ctx_summary`（2026-09-19 新增，影子回放数据载体）**：本次 run 的 `directives`（各 directive 的 `kind`/`entry`/`args` 摘要，不含 `eff` 回灌值——那在 `eff_log`）与轮首投影 `ctx` 摘要（身份 `active`/`body` 快照 + **保留 refs 哈希集合**（正文另存 def；影子重建的 ctx 可核对））。影子回放时，#44/影子执行器据新图重新构造等价 `directives`+`ctx`，按 `(port,method,canonicalJson(args))` 与 **`trace.eff_log`** 配对回灌，缺匹配则记 `shadow:"unverified"`；`host.audit` 读 `EffectAudit` 保留为**历史对照补充**（v1 以 eff_log 为准）（2026-09-20 修订）。这是 v1 闭环自进化环的载体（无它则「零 token 验证」无据可依）。
- **`workspace_id` 必填**：证据聚类按它分区（见 #44）——不同项目失败模式不同，混聚会把"项目特性不同"误诊成"能力缺失"。
- **`l1_iters` / `l1_maxed`**：L1 自治的过程数据。运行时**不拦** `no_progress`（解释器看不到 Scope 内部迭代，
  让 Scope 自己判又破"不能自己决定完成"），故降为**证据类型**、由 #44 事后聚类。
- **`refused_at`**：拒绝短路到 sink 是解释器的隐式控制流、图里不可见，故**必须在轨迹里可还原**（#33 验收 6）。

### `evidence` / `proposals` / `verdicts` 条目

```jsonc
// evidence（#44 产，或用户请求）
{ "kind": "evidence", "id": "ev-…",
  "class": "failure_cluster" | "post_failure" | "cost_anomaly" | "instance_drift"
         | "fold_candidate" | "no_progress" | "verify_failure" | "user_request",
  "cluster_key": { "code": "capability_mismatch", "attributable_to": "graph",
                   "workspace_id": "w1", "contract_id": "agent.step" | null },
  "n": 7, "window": { "from_run": "…", "to_run": "…" },
  "traces": [ {"def":"…"} ],                     // 支撑该证据的轨迹条目
  "source_message": {"def":"…"} | null,          // class=user_request：原始消息 def（可溯源、可审计）
  "at": "…", "prev": {"def":"…"} | null }

// proposals（#45 产，或图内提案 Scope 产）
{ "kind": "proposal", "id": "pr-…",
  "class": "binding" | "instance_growth" | "structure" | "fold",
  "evidence_ids": ["ev-…"],                      // **必填且非空** —— 无证据提案直接拒
  "target": { "graph": {"def":"…"} | null, "contract_id": null, "node_id": null },
  "patch": {"def":"…"},                          // 变更内容（新图 / 新 Scope / 新绑定），fork-only
  "by": "evolve-loop" | "user",
  "at": "…", "prev": {"def":"…"} | null }

// verdicts（门禁判定：采纳与拒绝**都写**）
{ "kind": "verdict", "id": "vd-…",
  "proposal_ids": ["pr-…"],                      // 打包内全部提案（判定单位 = 候选版本，不是单条提案）
  "evidence_ids": ["ev-…"],
  "result": "accepted" | "rejected" | "undecided",
  "gate": { "mechanical": "pass" | "fail", "reason": null | "llm_chain_max",
            "shadow": {"def":"…"} | null,        // 影子回放指标（零 token，历史输入 + `eff_log` 回灌）（2026-09-20 修订）
            "human": "approved" | "denied" | null },
  "adopted_gen": 12 | null,                      // accepted：#33 的新数据世代 seq
  "at": "…", "prev": {"def":"…"} | null }
```

- **`evidence_ids` 必填非空**（禁时钟驱动生长）；**用户请求也是一等证据**（`class:'user_request'`，
  带原始消息 def 哈希）⇒ 自主提案与用户请求**走同一条通道、过同一套门禁**，不出现旁路。
- **判定单位是"候选版本"不是单条提案**：`proposal_ids` 是数组——一回合通过额度的全部提案打包成一个候选，
  一起过闸、一起采纳或一起作废。被拒不销毁证据（下回合可按 `evidence_id` 拆开重提）。
- **`result:'rejected'` 也必须写**：只记采纳就看不出被拒过什么，环不可审计（验收 4）。

---

## 容量与清理

- **`trace` 是高频层**：**唯一清理者 = #44 `sweep`**（掌握 `verdicts` 引用集，产清理计划）；**#23 只清 L1/L2/L3**（双侧一致）——写新索引不含旧条目（def 仍在链上，这是 ① 档的既定代价，不是"删除"）（2026-09-20 修订）。
- **`evidence` / `proposals` / `verdicts` 是低频层**，永久保留（它们是"为什么变成这样"的唯一记录）。
- 清理只动索引、**不动已被 `verdict` 引用的轨迹**（否则溯源链断）；引用判定由 #44 在产清理计划时做。

---

## 跨插件登记

- **#33 loop-policy**（提出方）：回合尾写 `trace`；eff #44 聚合；提案 Scope 写 `proposals`；门禁写 `verdicts`；
  **采纳 = 对 #33 自身图数据世代 `add_gen`**（本身份只存台账、不存图）。写本身份台账条目时，由写入者（#33 / #44 / #45）对 **#43 自身台账数据世代 `add_gen`**——两处 `add_gen` 主语不同，勿混。
- **#44 evolve-metrics**：投影读 `trace` → 产 `evidence` 写计划；产 `trace` 清理计划。
- **#45 orchestration-admin**：投影读全部四类 → 产 `proposals` 写计划（**只产提案、不产写**）。
- **#17 ui-settings S13**：进化台账只读渲染（三类倒序列表，可下钻到 `trace` 与 `eff_log`）；**历史 `EffectAudit` 的读取经宿主保留身份 `host` + `audit` 方法**（D7，**历史对照补充——v1 数据底座以 `trace.eff_log` 为准**，2026-09-20 修订），不经本插件（本插件是纯数据身份、无 execute）。
- **宿主能力（H1 已落地）**：投影引用闭包解析（`{"def":hash}` → `ids.<id>.refs`，**全量返回**、`next_before` 恒 `null`——2026-09-20 修订）；
  与 #11 / #21 / #35 / #33 共用同一条，**本身份不新增宿主动词**。
