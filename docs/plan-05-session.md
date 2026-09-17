# 计划 05 · session 插件

> 前置：`plan-03`（engine）。
> 口径来源：`docs/agent.md` §3.3 / §6；`docs/plugins.md`。
> 本计划 = 加 `plugin/session.store` 插件；**不改**框架代码。

---

## 目标

加入会话 / 回合的边界与状态：可开、可续、可结，跨重启可 resume。

## 前置

`plan-03` 验收全绿。

## 本阶段交付

- `plugin/session.store`：1 执行件，`implements: ['session']`。
- 能力类 `session`（`open` / `append` / `close` / `resume`）——**引擎 `pins` 内部能力，不进 `caps`**。
- session 记录 def（边界、输入、进度、待批卡、结算）。
- `pins`：`plugin/storage.truth`、`plugin/storage.view`、`policy/*`。
- `engine.core` 新世代：`pins` 加入 `session.store`（一次 `add_gen`）。

## 本阶段口径

- session 是**引擎 pins 内部能力**：世界里的 term 调不到。
- 状态真源落 `storage.truth`；查询/投影走 `storage.view`。
- 会话边界只追加、不抹除；回滚是一次 `set_active`。

## 出口验收

1. 一次会话可 `open` → `append` → `close`；中途崩溃后能 `resume` 到同一状态。
2. 进度可查（已执行能力集 / 已写 slot 摘要 / 剩余预算）。
3. 会话记录逐字节可重放。

## 本阶段不做

- 上下文投影（`plan-06`）、记忆召回（`plan-07`）。
- 多设备 / 多用户同步。

## 范围红线

- 不改框架；不把 session 加进 `caps`。
- 不把判定写进执行件。

## 单次会话可完成

按 能力类骨架 → 记录 def → `resume` 验证 提交；超尺度即再切。
