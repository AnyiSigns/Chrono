# 计划 08 · skill 插件（结晶）

> 前置：`plan-07`（memory）。
> 口径来源：`docs/agent.md` §3.2 / §7；`docs/plugins.md`。
> 本计划 = 加 `plugin/skill.crystallize` 插件；**不改**框架代码。

---

## 目标

同一动作序列成功 k 次 → 结晶为一个 `skill` def，下轮以工具形式被选中一次。

## 前置

`plan-07` 验收全绿。

## 本阶段交付

- `plugin/skill.crystallize`：1 执行件，`implements: ['skill']`。
- 能力类 `skill`（`match` / `invoke`）——**引擎 `pins` 内部能力，不进 `caps`**。
- `skill/<name>` def；`pins` 必含"实现 pin"。
- term `crystallize`（结晶判据：动作序列 + 成功计数 k）。
- `pins`：`plugin/memory.fts`（成功轨迹）、`tool/*`（动作序列）、`policy/*`。
- `engine.core` 新世代：`pins` 加入 `skill.crystallize`。

## 本阶段口径

- k 以 def 形式住世界（可版本化、可回滚、可人工改）。
- 结晶 = 新增一个 `skill` def + 新实例（契约扩展），不是原地改。
- skill 是引擎 pins 内部能力，世界 term 调不到。
- 下轮以工具形式被选中一次（真实调用点，不是装饰）。

## 出口验收

1. 同一动作序列成功 k 次 → 结晶出一个 `skill` def，参数表非空且实现可解析。
2. 下一轮该 skill 以工具形式被选中一次并执行成功。
3. 删掉 skill 的 `add_gen` 回滚后行为回到结晶前。

## 本阶段不做

- 技能自动组合、退役策略、技能市场。

## 范围红线

- 不改框架；结晶走 `add_gen`，不就地改旧 def。
- 不把判定写进执行件。

## 单次会话可完成

按 能力类骨架 → `crystallize` term → `skill/<name>` def → 接入 提交；超尺度即再切。
