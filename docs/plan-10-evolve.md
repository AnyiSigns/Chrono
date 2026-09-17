# 计划 10 · evolve 插件（自进化）

> 前置：`plan-09`（bench + scorer）。
> 口径来源：`docs/agent.md` §2 A4/A5、§3.3、§6、§7.1、§8；`docs/plugins.md`。
> 本计划 = 加 `plugin/evolve.proposer` 插件；**不改**框架代码。

---

## 目标

跑通进化回合：提议 → 门禁 → 候选复评 → 采纳 / 弹卡 → 回滚。

## 前置

`plan-09` 验收全绿。

## 本阶段交付

- `plugin/evolve.proposer`：1 执行件，`implements: ['evolve']`。
- 能力类 `evolve`（`propose`）——**引擎 `pins` 内部能力，不进 `caps`**。
- `agent/proposer` 角色（behavior term）；`Round` 记录 + 回合锚（冻结 `bench`/`scorer` 哈希）+ 预算向量 `ROUND_B`。
- 门禁 term G0–G12（`agent.md` §8）；`approval` 分级 term（**归本插件**）。
- 候选 = 一条 `batch`：`put` + `add_gen`，**不** `set_active`。
- 复评：同锚在 dev + holdout 各跑一遍 incumbent 与候选 → `S_inc_*` / `S_cand_*`。
- `pins`：`bench/*`、`scorer/*`、`tool/*`、`model`、`plugin/storage.truth`（只读）、
  `plugin/panel.agent`、`config/user`。
- 命令：`boot round`、`boot view --round <n>`、`boot inbox`、`boot resolve <p> <auto|deny>`、
  `boot rollback <id> <gen>`。

## 本阶段口径

- 判据按回合冻结，改判据只影响下一轮（A4/G2）。
- 双集门槛 G7：`S_cand_dev ≥ S_inc_dev + Δ` 且 `S_cand_holdout ≥ S_inc_holdout − ε`，
  且统计显著（Wilson CI 不重叠、每臂 n ≥ 200），且 `fit(new) > fit(incumbent)`，
  `fit = S_dev − λ·cost`，`cost = 归一化(Round.spent, ROUND_B)`。
- 判据身份（`bench/*`、`scorer/*`、门禁 term、`approval` 分级 term）对 agent **恒 `deny`**，只能由人改。
- `config/user`、`credential/*` 落 `review`；`storage.truth` 落 `deny`。
- 三档 `auto` / `review` / `deny`；超时即 `deny`（fail-closed）。
- 提案者不能给自己打分：`agent/proposer` ≠ `agent/executor`。

## 出口验收

1. 验收 4（跨代提升）、5（自动采纳）、6（弹卡待批）、7（回滚可证）。
2. 验收 9（非法提案被拒：改测试 / 泄漏 holdout / 判据同轮生效各自被拒）。
3. 验收 14（判据身份不可自改：agent 提议被 `deny`，人提交放行且下一轮生效）。
4. `Round` 记录含同锚的 `S_inc_*` 与 `S_cand_*`。

## 本阶段不做

- 面板内容（`plan-11`）、MCP（`plan-12`）、自改宿主（`plan-13`）。
- N 路并行提案、协作者投票。

## 范围红线

- 不改框架；判据以 term / def 住世界，不写进宿主或执行件。
- 不手写 `passed`；不放宽判据身份。

## 单次会话可完成

按 `Round` 锚 → `propose` → 门禁 → 复评 → 弹卡 / 回滚 逐段提交；超尺度即再切。
