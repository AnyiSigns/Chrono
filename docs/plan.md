# 计划索引

> 口径来源：`docs/agent.md`（设计权威）、`docs/plugins.md`（插件分离）、`docs/plan-00-framework.md`（框架）。
> 规则：**plan-00 搭框架与装配；此后每个计划只加插件、加插件的依赖，不改框架代码。**

| 计划 | 内容 | 前置 | 状态 |
| --- | --- | --- | --- |
| `plan-00-framework.md` | 端到端框架 + 装配层 + 端口机制（无任何插件） | kernel | 已写 |
| `plan-01-model.md` | model 三层链 + `config` / `credential` + 降级链 | 00 | 已写 |
| `plan-02-ui.md` | ui 通道（`ui.terminal` / `ui.plain`） | 00 | 已写 |
| `plan-03-engine.md` | `engine.core` 回合循环 + `agent/executor` | 01、02 | 已写 |
| `plan-04-tool-sandbox.md` | `tool/*` + `sandbox/rust`（`exec` / `fs`） | 03 | 已写 |
| `plan-05-session.md` | `session.store` | 03 | 已写 |
| `plan-06-context.md` | `context.budget` | 03、05 | 已写 |
| `plan-07-memory.md` | `memory.fts` | 03、05 | 已写 |
| `plan-08-skill.md` | `skill.crystallize`（结晶） | 07 | 已写 |
| `plan-09-bench-scorer.md` | `bench/*` + `scorer/*` | 04 | 已写 |
| `plan-10-evolve.md` | `evolve.proposer`（含 `approval` 分级） | 09 | 已写 |
| `plan-11-panel.md` | `panel.agent`（面板内容） | 02、10 | 已写 |
| `plan-12-mcp.md` | `mcp.client` | 03 | 已写 |
| `plan-13-selfhost.md` | 自改宿主（非插件） | 03–12 | 已写 |

## 每个计划的自包含模板

1. 目标
2. 前置
3. 本阶段交付（插件目录 / `plugin.json` / 成员 / `pins` / 能力类 / 命令）
4. 本阶段口径
5. 出口验收
6. 本阶段不做
7. 范围红线
8. 单次会话可完成

## 硬规则

- 计划文件只写"怎么做"，不重述设计口径；冲突时以 `agent.md` 为准。
- `plan-00` 之后**不改** `boot` / `host` / `assembly` 的框架代码；引擎换代走 `engine.core` 的 `add_gen`。
- 插件之间只靠 `pins`；调用方只写能力类名。
