# turn-ledger（回合台账 / 提案）

回合尾台账与提案：**trace 条目组装 + 提案扫描 + 采纳 / 拒绝 verdict**，单世代原子写出。
图数据与解析后的图模型随 `args` 传入（服务**不读投影**）；机械闸 `graph-gate`、影子回放 `evolve-metrics`、
人闸 `approval` 经反向调用 `port.call` 消费。上游 `loop-policy` 门面消费本提供方组装回合尾账本。

- 身份：`turn-ledger`
- 能力类 / 方法：`turn-ledger` → `settle`（trace 条目 + 提案扫描，trace 与 verdict 同世代一次写出）、
  `decide`（编排变更裁决续跑：采纳写回 `loop-policy` body / 登记拒绝 verdict）
- `pins`：无（`"pins": {}`）；`needs`（一律 `mode:"one"`）：`graph-gate` / `evolve-metrics` / `approval`
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖；服务不写链、不读投影；跨插件只走 `port.call`；`now` 取 `env.now`

## 方法

| 方法     | 入参                                                                   | 返回                                                     |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `settle` | `{bag, model, pins?, trace, directives?, graph_hash?, scan?, at?}`      | `{extra, batch, pending, events}`                        |
| `decide` | `{bag, pins?, resume, at?}`                                             | `{batch, summary}`                                       |

- `settle`：`batch` 是 trace 条目 + verdict 的**单世代**原子写计划（`add_gen evolution`）；`extra` 是影子指标 def 与
  审批入队等直传计划。`trace` 是 `graph-run` 回传的纯数据事实（`{steps,eff_log,refused_at,branch_not_taken,
  branches_not_taken,link_taken,outcome}`）。
- `decide`：`approved` ⇒ 按 `patch.writes[]` 登记 `add_gen`（`loop-policy` 图 + 跨身份写）与 `accepted` verdict；
  `denied` ⇒ 登记 `rejected` verdict。

## 红线（写死）

1. **trace 与 verdict 同世代**：同回合的 trace 条目与 verdict 由一个 `RoundPatches` 累积器 `finalize` 成
   一条原子 batch，槽位 `count` / `tail` 一次修正。
2. **proposal 单世代原子性**：机械闸不过 / 人闸入队 / 采纳 / 拒绝的 verdict 登记均并入同一世代。
3. **采纳写回 `loop-policy` body**：采纳图的 `add_gen` 目标身份是 `loop-policy`（图数据真源）。

## 提案扫描与采纳

回合尾读 evolution `proposals` 未决项（newest→oldest）→ `port.call graph-gate.validate`（机械闸）→
`port.call evolve-metrics.shadow`（零 token）→ `approval.enqueue` 产 `orchestration_change` 入审批 → 本 run 结束。
机械闸不过的提案直接落 `rejected` verdict（不入人闸）。裁决续跑经 `decide`：
`approved` ⇒ 按 `patch.writes[]` 展开 `add_gen` + `accepted` verdict；`denied` ⇒ `rejected` verdict。

## 边界

- 不做：图执行 / 解释器推进（归 `graph-run`）；bag 水合 / 契约版本校验 / 会话收口 / 取消标志（归 `loop-policy`）。
- 不读投影、不写链；不取时间 / 随机（`now` 取 `env.now`）；同输入同输出。
- 服务不 import 宿主与内核；跨身份只走 `port.call`。

## 运行

```sh
npm test    # 协议级 + 单元测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
