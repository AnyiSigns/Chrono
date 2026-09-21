# skill（技能包：内联清单 + 结构化触发 + 作用域）

技能的**存储本体**：只存数据、不判定、不起进程。技能是纯文本说明，
**不含可执行内容**——要执行走沙箱与工具族。

本包是**数据身份**：只有 `schema`，无服务进程、无 pins、无命令、无 eff。

## 身份与数据

- 身份：`skill`
- body：`{ version, skills: [ ... ] }`，二者必填；技能数量少，**内联列表**（不做链式）。
- 每条技能：`{ id, name, description, triggers, scope?, body, enabled?, at? }`。
- `triggers`（结构化触发，命中任一即候选）：
  - `keywords`：对当前轮文本；
  - `file_globs`：对上下文涉及的文件；
  - `explicit`：用户显式点名（如 `@测试`）。
- `scope`：`{ kind: "global" | "workspace" | "session", workspace_id?, session_id? }`；
  **缺键 ≡ `{ kind: "global" }`**。`workspace` 技能在其它工作区不进候选集（由解释器过滤）。
- `body`：纯文本说明；`enabled` 缺键 = 启用。
- 形态校验归写入端（宿主 v1 不校验身份数据）。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.skill.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入

整值 `put` + `add_gen`：读回整份 body、改 `skills` 列表、整值写回（读-改-写）。
选择哪些技能、怎么注入由读取方（解释器）判定，本身份不判定。

## 默认 body 预置（可复现）

- `tools/default-body.json`：`{ "version": 1, "skills": [] }`（空即无技能）。
- 写入与完整性校验见 `plugins/agents/tools/e2e-smoke.mjs`（三包合并的端到端冒烟）。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
