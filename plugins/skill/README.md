# skill（技能包：内联清单 + 结构化触发 + 作用域）

技能的**存储本体**：只存数据、不判定、不起进程。技能是纯文本说明，
**不含可执行内容**——要执行走沙箱与工具族。

本包是**服务**：`skill.read` / `skill.write` 两个命令；技能清单是运行记录，住自有持久存储（④）。

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

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界） | 存储格式版本 |
| `skills[].id` / `name` / `description` / `body` / `enabled` / `at` | 运行记录（出世界） | 用户技能清单；回滚不该带 |
| `skills[].triggers` | 运行记录（出世界） | 结构化触发是**判定输入**（候选集选择），但解释器经 `bag.skills` 运行时读 owner，不从世界读 |
| `skills[].scope` | 运行记录（出世界） | 作用域过滤同样是运行时读 owner，不从世界读 |

**结论**：技能清单无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def）。

## 提供哪些命令

- `skill.read`（只读，无参）：入口 term 取 `ctx.ids.skill` 世界切片作基线，经 `eff` 问 owner 服务；
  服务把世界基线 + 自有存储合并后回整份视图（`active` / `body` / `data_gen` / `pins` / `refs`）。
- `skill.write`（整份）：入参 `{ body }`（整份 `{ version, skills }`）；写自有存储，同内容幂等短路。

## 怎么起

`start: node execute/main.ts`；`pins` 无；`exclusive: ["data"]`（④ 单写者）。

## 状态档

`state: "durable"`（④ 不可重算；技能清单跨代存活、进备份、只按身份消失回收）。

## 存储引擎与落点（自写）

- ④ 落点：`CHRONO_PLUGIN_DATA/skill.jsonl`，单文件追加日志（每条一次 append + fsync，换行收尾）。
  记录 `{t:'body', run, body}`；启动重放取最后一条 body，末行半写撕裂 / 坏行跳过（fail-open）。
- **边跑边追加**：`skill.write` 即时写一条记录；同内容重复写幂等短路；每条记录盖回合 id（`run`）。
- **存量不搬**：存储从空开始；读时把世界遗留 body 作基线合并（存量可读），但不写回世界。
- **清理责任**：自写存储；owner 退役时宿主按身份回收删除 `state/data/skill/`，无需额外清理方法。

## 默认 body 预置（可复现）

- `tools/default-body.json`：`{ "version": 1, "skills": [] }`（空即无技能），作为首启基线。
- 写入与完整性校验见 `plugins/agents/tools/e2e-smoke.mjs`（三包合并的端到端冒烟）。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/` / `execute/`）随源码入世。
