# 计划 03 · engine 插件（回合循环 + executor）

> 前置：`plan-01`（model）、`plan-02`（ui）。
> 口径来源：`docs/agent.md` §6 / §7；`docs/plugins.md`。
> 本计划 = 加 `engine.core` 插件；**不改**框架代码。

---

## 目标

加入回合循环与编排，跑通最小对话闭环；引擎行为由 term 驱动，后续能力插件逐个按 `pins` 接入。

## 前置

`plan-01`、`plan-02` 验收全绿。

## 本阶段交付

- `plugin/engine.core`：1 执行件，`implements: ['engine']`；提供 `agent/executor` 角色（behavior term）。
- 能力类 `engine`（`step` / `resume`）。
- 编排：`agent/executor` 的 behavior term 在归约机里跑，遇 `eff` 挂起 → 宿主执行 → 审计 def →
  回灌 `results` → 同 `run_id`/`now`/`directives` 续跑 → `done`。
- `pins`：`model`、`ui`、`policy/*`（最小）；`context` / `session` / `memory` / `skill` / `tool` 先不 pin。
- 命令：`boot run --task <id>`（多轮对话）。

## 本阶段口径

- 效果放叶子、长循环拆 directive（内核 §12 的成本纪律）。
- 回合推进 / 取用 / 效果执行在宿主；判定 / 路由写成 term。
- 上下文投影走宿主/引擎，term 读不到存储（`base_only`）。
- 引擎换代 = 对 `plugin/engine.core` 一次 `add_gen` + `set_active`，不改装配层。

## 出口验收

1. 能多轮对话，每回落账可校验。
2. 同输入重放逐字节一致。
3. 挂起 → 审计 → 回灌 → 续跑 → `done`，路径可复现。

## 本阶段不做

- tool / sandbox（`plan-04`）、session / context / memory / skill（`plan-05`–`08`）。
- 进化回合、门禁、弹卡（`plan-10`）。

## 范围红线

- 不改框架；引擎不直接 import 其他插件，只经 `pins` + 能力类名。
- 不把判定写进引擎代码。

## 单次会话可完成

按 执行件骨架 → `eff` 续跑 → 多轮对话 提交；超尺度即再切。
