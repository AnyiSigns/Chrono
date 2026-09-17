# 计划 11 · panel 插件（agent 面板内容）

> 前置：`plan-02`（ui 通道）、`plan-10`（evolve）。
> 口径来源：`docs/agent.md` §7.1；`docs/plugins.md`。
> 本计划 = 加 `plugin/panel.agent` 插件；**不改**框架代码。

---

## 目标

把 agent 状态的界面**内容**做成声明（face），渲染仍走 ui 通道；三类面在闭环里各有真实调用点。

## 前置

`plan-02`、`plan-10` 验收全绿。

## 本阶段交付

- `plugin/panel.agent`：**0 执行件**，纯 face 声明 def：
  - `face/round.report`：回合结束（两端分数、门禁结论、拒因），走 `render`。
  - `face/proposal.card`：候选过门槛后（diff + 证据 + 判据哈希），走 `ask`。
  - `face/interrupt.card`：构建失败 / 执行件崩溃 / 沙箱拒绝，走 `notify` / `ask`。
- `Face` 形态：`blocks`（text / kv / diff / list / markdown，数据一律经 `pins` 引用）+ `actions` + `timeout`。
- `pins`：`plugin/ui.terminal`（通道）、`plugin/ui.plain`（兜底）。

## 本阶段口径

- **panel = 内容，ui = 通道**：换面板 = 换声明；换通道 = 换 ui 插件。
- face 是声明式数据，不内联业务数据（规矩 A：结构性依赖只走 `pins`）。
- 三个裁决词语义固定：`auto` 放行 / `review` 挂起待批 / `deny` 驳回；超时即 `deny`。
- 弹卡时机：`approval` term（在 `evolve.proposer`）初判 `auto` / `deny` 不弹卡，只有 `review` 才弹卡。
- 人的裁决写成 `decision` 记录，驱动 `set_active` 并作为后续判据修订 / 记忆沉淀的高权重证据。

## 出口验收

1. 三类面在闭环里各被真实调用一次（不是装饰）。
2. face 声明形态不合 → `schema` 门禁在 `add_gen` 前拒。
3. 面板换代只换声明，ui 通道不动。

## 本阶段不做

- 前端图形界面、主题市场。
- 新增裁决词或改三词语义。

## 范围红线

- 不改框架；不改 ui 通道；`approval` 不迁回本插件。
- face 不内联业务数据。

## 单次会话可完成

按 三个 face 声明 → `schema` 门禁 → 三面真实调用 提交；超尺度即再切。
