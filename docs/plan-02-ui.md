# 计划 02 · ui 通道（渲染 / 兜底）

> 前置：`plan-00`（框架 + 装配）。
> 口径来源：`docs/agent.md` §7.1；`docs/plugins.md`。
> 本计划 = 加一批插件；**不改**框架代码。

---

## 目标

加入渲染**通道**，使 `render` / `ask` / `notify` 可用，且 UI 崩了不卡死闭环。

## 前置

`plan-00` 验收全绿。

## 本阶段交付

- `plugin/ui.terminal`：1 执行件，`implements: ['ui']`，方法 `render` / `ask` / `notify`。
- `plugin/ui.plain`：1 执行件（兜底面），把 view 打成 JSON 到 stdout。
- 能力类 `ui`（`render(view) → ack` / `ask(view) → {verdict,note}` / `notify(view) → ack`）。
- 说明：**面板内容不在此**（`plan-11` 的 `panel.agent`）；本计划只做通道。

## 本阶段口径

- UI 是普通插件，与它件同路、靠 `pins` 依赖、无特例。
- `render` 崩 / 超时 → 立刻改用 `plugin/ui.plain`，并按 `timeout.verdict` 走 `deny`（fail-closed）。
- 非 TTY / headless → `ask` 立即返回 `review`，候选累积到 `boot inbox`。
- UI 改动不影响评分，故 `verdict_hint=auto`；仍受 G1/G2 与"坏了也不停机"约束。

## 出口验收

1. 用一个 toy 调用方驱动 `render` / `ask` / `notify` 各一次，留痕可查。
2. 把 `render` 执行件换成崩溃桩 → 闭环仍跑完（走 `ui.plain`，裁决按 `deny`）。
3. 非 TTY 下 `ask` 返回 `review`，不阻塞。

## 本阶段不做

- 面板内容（face 声明）→ `plan-11`。
- 前端图形界面、主题市场。
- 引擎（`plan-03`）。

## 范围红线

- 不改框架；不给 UI 开特例。
- 不把判定写进渲染执行件。

## 单次会话可完成

按 `ui.terminal` → `ui.plain` → 崩溃兜底验证 提交；超尺度即再切。
