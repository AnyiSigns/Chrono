# 计划 09 · bench + scorer 插件

> 前置：`plan-04`（tool + sandbox）。
> 口径来源：`docs/agent.md` §3.2 / §6 / §8（G3/G4/G6）；`docs/plugins.md`。
> 本计划 = 加一批插件；**不改**框架代码。

---

## 目标

加入任务集与判据：真跑测试判分，dev 与 holdout 严格隔离。

## 前置

`plan-04` 验收全绿（`exec` 可用，能真跑测试）。

## 本阶段交付

- `bench/<name>`：bench-manifest def（`bench/coding.dev`、`bench/coding.holdout`），每个 task 一个 def。
- `scorer/<name>`：term def（断言）+ 被引用的断言 def；真跑测试判分。
- 判据：测试 fixture 以哈希 pin；评测用测试文件哈希钉死。
- 任务结果 def；聚合得 `S_dev` / `S_holdout`。
- `pins`：`sandbox/rust`（scorer 真跑测试）。

## 本阶段口径

- **dev 与 holdout 任务集无交集**（哈希集合），判据由机器从指标重算，禁手写 `passed`。
- 判分要真跑测试（`exec` 端口），不是模型自评。
- 测试文件哈希 == 钉死哈希，不许改 / 删（G6）。
- holdout 只准冻结模型前向；提案上下文与 `Proposal.evidence` 不含 holdout（G3/G4）。

## 出口验收

1. 同一 bench 上 `scorer` 真跑测试并给出任务结果 def。
2. dev 与 holdout 哈希集合无交集，可机检。
3. 改 / 删测试文件 → 该任务分 0（G6）。
4. 判据变更不影响本轮锚（留给 `plan-10` 的回合锚验证）。

## 本阶段不做

- 提议 / 复评 / 采纳 / 弹卡（`plan-10`）。
- 难度刻度、负载均衡等实验项。

## 范围红线

- 不改框架；bench / scorer 只以 def 与 term 形态存在。
- 判据不写进宿主代码；不手写 `passed`。

## 单次会话可完成

按 `bench` manifest → `scorer` term → 真测试判分 → 隔离机检 提交；超尺度即再切。
