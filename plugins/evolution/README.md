# evolution（进化台账：trace / evidence / proposals / verdicts）

自进化环的**唯一落点**：只存台账、不聚合、不判定、不起进程。
- **trace**：回合尾轨迹摘要（高频层，可清理）。
- **evidence**：证据（低频层，永久保留）。
- **proposals**：提案（低频层，永久保留）。
- **verdicts**：门禁判定——**采纳与拒绝都写**。

本包是**数据身份**：只有 `schema`，无服务进程、无 pins、无命令、无 eff。

## 身份与数据

- 身份：`evolution`
- body 四条链头：`{ version, trace, evidence, proposals, verdicts }`，五者必填。
- 每条索引形如 `{ tail, count }`：`tail` = `{ "def": "<链头条目 def 哈希>" }` 或 `null`（空链）；
  `count` = 条目数。**不在 body 里列全部条目**——加一条 = 1 条目 def + 1 索引 def，不重写全量。
- 四类条目**各自成 def、带 `prev` 成链**（`prev` = `{ "def": hash }` 或 `null`）：
  - `trace`：`{ kind:"trace", run, session, workspace_id, graph, steps[], directives_summary, ctx_summary, refused_at, branch_not_taken, link_taken[], outcome, at, prev }`；
    `steps[]` 每步带 `eff_log[]`（`{step, iter, port, method, args_hash, result_hash, outcome}`）。
  - `evidence`：`{ kind:"evidence", id, class, cluster_key, n, window, traces[], source_message, at, prev }`。
  - `proposal`：`{ kind:"proposal", id, class, evidence_ids[], target, patch, by, at, prev }`；
    **`evidence_ids` 必填且非空**（无证据提案直接拒）。
  - `verdict`：`{ kind:"verdict", id, proposal_ids[], evidence_ids[], result, gate, adopted_gen, at, prev }`。
- 轨迹只存**摘要 + 引用**，正文不重复存；从 `verdict` 可反查 `proposal` → `evidence` → `trace` → `eff_log`（全链可溯源）。
- 条目 body 里的 `{ "def": hash }` 标记由宿主投影闭包解析进 `ids.evolution.refs`。
- 形态校验归写入端（宿主 v1 不校验身份数据）。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.evolution.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入

写一条 = `put(条目 def) + put(新 body) + add_gen`（同一条原子 batch）。
- 链式写：新 body 的对应 `tail` 指向新条目 def（批内可用 `{ "$n": k }` 占位符指向更早的 `put`）；
  跨批续链时用字面 def 哈希写进下一条的 `prev`。
- 不重写全量：只改对应索引的 `tail` / `count`，其余三条索引原样带回。

## 容量与清理

- `trace` 是高频层：写新索引不含旧条目（def 仍在链上）。
- `evidence` / `proposals` / `verdicts` 是低频层，永久保留。
- 清理只动索引，不动已被 `verdict` 引用的轨迹（否则溯源链断）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：四条空链 `{ version: 1, trace:{tail:null,count:0}, evidence:{...}, proposals:{...}, verdicts:{...} }`。
- 链式写入与完整性校验见 `plugins/agents/tools/e2e-smoke.mjs`（三包合并的端到端冒烟）。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
