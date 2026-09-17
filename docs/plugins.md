# 插件清单与分离规则

> 口径来源：`docs/agent.md`（§3.2 身份与成员、§5 装配层、规矩 A）。
> 本文件把上层能力**逐插件分离**，写死"插件之间只靠 `pins` 依赖"的交互面。
> 已定口径见"已定"；标 **待确认** 的条目不要按现状实现。

---

## 分离规则（不可破）

1. 一个插件 = 一个目录 = 一个身份 = 一个仓库 = 一批成员（agent.md §3.2）。
2. 插件之间**只通过 `pins` 依赖 + 能力类名**交互；**不直接 import、不共享进程内对象**。
3. 调用方只写**能力类名**；具体实现由生效世代的 `pins` 决定——换实现不改调用方、不改 term。
4. 每个插件可单独 `add_gen` / `set_active` / `retire`，单独换代与回滚。
5. 一个插件可含 0..n 执行件 + 0..n term + 0..n 声明；三种成员同路，无特例。
6. 装配层不认识插件种类；**新增/替换插件不改装配层**（plan-00 的框架判据）。

## 已定

- **交互面**：`engine` / `context` / `session` / `memory` / `skill` / `evolve` 六类一律走**引擎 `pins` 内部能力**，
  **不进 `caps`**（同 `storage.*`）：世界里的 term 调不到，只有引擎/宿主经 `pins` 调用。
- **面板 vs UI**：`plugin/panel.*` = 界面**内容**（face 声明，0 执行件）；`plugin/ui.*` = 渲染**通道**。
  换面板 = 换声明，换通道 = 换 ui 插件。
- **`approval` 归属**：裁决分级 term 归 `plugin/evolve.proposer`（与门禁、复评同属进化回合）。
- **引擎归属**：回合循环与编排**也拆成插件**（`plugin/engine.*`），不在框架内。

## 上层能力插件清单

| 插件 | 职责 | 提供 | 依赖（`pins`） |
| --- | --- | --- | --- |
| `plugin/engine.core` **引擎** | 回合循环、上下文编排、端口编排；行为由 term 驱动 | 能力类 `engine`（`step`/`resume`）、`agent/executor` 角色（behavior term） | `plugin/context.budget`、`plugin/session.store`、`plugin/memory.fts`、`plugin/skill.crystallize`、`tool/*`、`model`、`plugin/panel.agent`、`policy/*` |
| `plugin/context.budget` **上下文** | 世界 → 模型上下文：预算（字符）、权重×相关度分配、喂了什么/丢了什么留痕 | 能力类 `context`（`build`）、term `select`/`trim`、留痕声明 | `plugin/storage.view`、`policy/context.*`、（可选）`plugin/memory.fts` |
| `plugin/panel.agent` **agent 面板** | agent 状态的界面**内容**：回合报告 / 提案卡 / 异常卡 | face 声明 def（0 执行件） | `plugin/ui.terminal`（通道）、`plugin/ui.plain`（兜底） |
| `plugin/session.store` **session** | 会话 / 回合边界与状态：输入、进度、待批卡、结算 | 能力类 `session`（`open`/`append`/`close`/`resume`）、session 记录 def | `plugin/storage.truth`、`plugin/storage.view`、`policy/*` |
| `plugin/memory.fts` **memory** | 成功/失败沉淀为 entry，按 tag + recency 召回 | 能力类 `memory`（`settle`/`recall`）、`memory/<agent>` set def | `plugin/storage.view`（FTS5）、`plugin/session.store` |
| `plugin/skill.crystallize` **结晶** | 同一动作序列成功 k 次 → 结晶为 `skill` def，下轮以工具形式被选中 | 能力类 `skill`（`match`/`invoke`）、`skill/<name>` def、term `crystallize` | `plugin/memory.fts`、`tool/*`、`policy/*` |
| `plugin/evolve.proposer` **自进化** | 提议 → 门禁 → 复评 → 采纳/弹卡/回滚 | 能力类 `evolve`（`propose`）、`agent/proposer` 角色、`Round` 回合锚、门禁 term（G0–G12）、**`approval` 分级 term** | `bench/*`、`scorer/*`、`tool/*`、`model`、`plugin/storage.truth`（只读）、`plugin/panel.agent`、`config/user` |

## 其余插件

| 插件 | 职责 | 依赖（`pins`） |
| --- | --- | --- |
| `plugin/protocol.model` | canonical schema + `validate_req` term | — |
| `plugin/adapter.model.*` | canonical ↔ 厂商协议（纯映射） | `plugin/protocol.model` |
| `plugin/vendor.*` | 端点 / 模型名 / 能力位 / `auth_ref`（纯声明） | `plugin/adapter.model.*` |
| `plugin/ui.terminal` / `plugin/ui.plain` | 渲染通道 / 兜底 | — |
| `plugin/config.model` | 可用项清单 + 界面声明（纯声明） | — |
| `plugin/storage.truth` / `plugin/storage.view` | 真源写口 / 派生视图 | `plugin/storage.truth`（view 可选） |
| `plugin/mcp.client` | MCP server 接入 | — |
| `tool/*` | 工具 | `sandbox/*`、`plugin/storage.*` |
| `sandbox/rust` | `exec` 实现 | — |
| `bench/*` / `scorer/*` | 任务集 / 判据 | `sandbox/rust`（scorer 真跑测试） |

## 依赖图（上层能力）

```
engine.core ──▶ context.budget ──▶ storage.view
     │  │  │
     │  │  └──▶ session.store ──▶ storage.truth / storage.view
     │  └─────▶ memory.fts ──▶ session.store
     │  └─────▶ skill.crystallize ──▶ memory.fts / tool/*
     ├────────▶ tool/* ──▶ sandbox/rust
     ├────────▶ model(protocol → adapter → vendor)
     └────────▶ panel.agent ──▶ ui.terminal / ui.plain

evolve.proposer ──▶ bench/* / scorer/* / tool/* / model / storage.truth(读) / panel.agent
```

## 与 `agent.md` 的冲突点（分离后必须改）

1. **§1 / §1.1**：`agent` 引擎不再是框架包，而是 `plugin/engine.core` 插件身份（可仍作宿主同进程成员）。
2. **§3.2 `agent/<role>` 门禁**：现要求声明 `model`/`tools`/`policy`/`context` 四项；`context` 独立成插件后，
   应改为只声明 `model`/`tools`/`policy`，`context` 走 `pins`。
3. **§7 八件表**：上下文工程 / memory / skill 现写在 `agent` 引擎内，应改为上表的独立插件；
   另加 engine / session / evolve / panel 四件。
4. **§7.1 `approval` term**：现挂在 `plugin/ui.terminal`，应移到 `plugin/evolve.proposer`。
5. **§12.1 包布局**：`agent/` 注释"回合循环、上下文、记忆、skill、进化回合、门禁"应缩为"（空，见 plugins）"或删除；
   新增 `plugins/engine/`、`context/`、`session/`、`memory/`、`skill/`、`evolve/`、`panel/`。
6. **§4 端口表**：`context`/`session`/`memory`/`skill`/`evolve`/`engine` **不进 `caps`**，
   在 §4 只登记为"引擎 pins 内部能力"。

## 待确认

- **Q1 引擎插件命名**：`plugin/engine.core` 是否合适？还是 `plugin/engine`（无二级名）？
- **Q2 角色归属**：`agent/executor` 由 `plugin/engine.core` 提供、`agent/proposer` 由 `plugin/evolve.proposer` 提供——
  是否照此？还是两个角色各自独立成 `agent/*` 插件？

## 框架之后的插件计划

框架（`plan-00`）验收全绿后，逐插件推进；每个计划 = 一个插件（或一组），只写插件目录 + `plugin.json` +
成员 + 该插件验收，不改框架代码。首批 = **engine + model + UI（最小对话界面）**，随后按依赖序补
session → context → memory → skill → tool/sandbox → bench/scorer → evolve → panel → MCP → 自改宿主。
