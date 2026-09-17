# 计划 07 · memory 插件

> 前置：`plan-03`（engine）、`plan-05`（session）。
> 口径来源：`docs/agent.md` §4.4 / §7；`docs/plugins.md`。
> 本计划 = 加 `plugin/memory.fts` 插件；**不改**框架代码。

---

## 目标

成功 / 失败沉淀成 entry，下一轮按 tag + recency 召回并进上下文预算（**不需要向量库**）。

## 前置

`plan-03`、`plan-05` 验收全绿。

## 本阶段交付

- `plugin/memory.fts`：1 执行件，`implements: ['memory']`。
- 能力类 `memory`（`settle` / `recall`）——**引擎 `pins` 内部能力，不进 `caps`**。
- `memory/<agent>` set def；每条 entry 含 `kind` / `text` / `tags` / `source_run` / `at`。
- 召回索引：FTS5（tag + recency）；`pins`：`plugin/storage.view`、`plugin/session.store`。
- `engine.core` 新世代：`pins` 加入 `memory.fts`；`context.budget` 新世代 pin `memory.fts`（可选）。

## 本阶段口径

- 召回走 FTS5，不引向量库；索引是派生物，丢了重扫（G11）。
- `settle` 在回合收尾触发（`agent.md` §7 的 settle）。
- memory 是引擎 pins 内部能力，世界 term 调不到。
- 召回项进上下文预算，占用计入 `context` 留痕。

## 出口验收

1. 回合结束 `settle` 沉淀成功 / 失败各一条，字段齐全。
2. 下一轮 `recall` 按 tag + recency 取回并进预算。
3. 删索引重扫后召回结果逐字节复原。

## 本阶段不做

- 记忆晋升分层、冲突消解、向量检索。
- 技能结晶（`plan-08`）。

## 范围红线

- 不改框架；memory 不写 `storage.truth` 真源以外的东西。
- 不把判定写进执行件。

## 单次会话可完成

按 能力类骨架 → entry 形态 → FTS5 召回 → 接入 提交；超尺度即再切。
