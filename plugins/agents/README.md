# agents（智能体数据身份：模板 / 实例（人格）/ 通道）

智能体相关数据的**存储本体**：只存数据、不判定、不起进程。
- **模板**：新建子代理 / 提案预填的候选人格（预留，暂无消费方）。
- **实例（人格）**：是谁——提示词 / 模型 / 解码参数 / 偏好工具 + 作用域。
- **通道**：跨回合留言板——写进世界，下一回合经投影读到。

本包是**数据身份**：只有 `schema`，无服务进程、无 pins、无命令、无 eff。

## 身份与数据

- 身份：`agents`
- body：`{ version, templates, instances, channels }`，四者必填。
- 每个索引形如 `{ tail, count }`：`tail` = `{ "def": "<链头条目 def 哈希>" }` 或 `null`（空链）；
  `count` = 条目数。**不在 body 里列全部哈希**——加一条 = 1 条目 def + 1 索引 def，不重写全量。
- 三类条目**各自成 def、带 `prev` 成链**（`prev` = `{ "def": hash }` 或 `null`）：
  - 模板条目：`{ id, name, system_prompt:{def}, model?, decoding?, prefer_tools?, scope, prev }`（预留）。
  - 实例条目（人格）：同上形状；`scope = { kind: "global" | "workspace" | "session", workspace_id?, session_id? }`。
  - 通道条目：`{ id, channel?, from, to?, text, at, prev }`。
- 条目 body 里的 `{ "def": hash }` 标记由宿主投影闭包解析进 `ids.agents.refs`；
  链指针 `prev` 就是普通数据值（同一个标记形状）。
- 形态校验归写入端（宿主 v1 不校验身份数据）。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.agents.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入

写一条 = `put(条目 def) + put(新 body) + add_gen`（同一条原子 batch）。
- 链式写：新 body 的对应 `tail` 指向新条目 def（批内可用 `{ "$n": k }` 占位符指向更早的 `put`）；
  跨批续链时用字面 def 哈希写进下一条的 `prev`。
- 不重写全量：只改对应索引的 `tail` / `count`，另外两条索引原样带回。

## 默认 body 预置（可复现）

- `tools/default-body.json`：三条空链 `{ version: 1, templates:{tail:null,count:0}, instances:{...}, channels:{...} }`。
- 链式写入与完整性校验见 `tools/e2e-smoke.mjs`（三包合并的端到端冒烟）。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
