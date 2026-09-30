# loop-policy（策略门面 / 图与策略数据身份）

**门面 + 数据身份**：保留公开方法面 `loop-policy.interpret` / `loop-policy.cancel`（消费方零改动），
重量级逻辑已下沉为两个提供方插件：

- `graph-run`（图执行引擎）：运行期结构闭合 / 拓扑前推 / 节点派发 / 拒绝短路 / 跨段重入 / 取消。
- `turn-ledger`（回合台账 / 提案）：trace 条目组装 / 提案扫描 / 采纳 / 拒绝 verdict，单世代原子写出。

本插件保留图与策略的**数据身份**（六类条目 / 种子回落 / 契约版本边界 / 引用水合 / 会话收口）与公开方法名，
执行与账本经反向 `port.call` 委派给上述提供方。

## 能力类 / 方法

- `loop-policy.interpret`（`interpret(bag)`）：门面编排一段回合——
  水合引用闭包 → 契约版本边界 → （编排变更裁决续跑 | `graph-run.run`）→ `turn-ledger.settle` → `session.turn_settle`。
- `loop-policy.cancel`（`cancel(turn_id)`）：转发取消意图给 `graph-run.cancel`（运行中的 run 在派发边界查、命中即停）；幂等。
  两者同为 `concurrent_methods`，`cancel` 才不会被在途 `interpret` 挡住。

## 入口契约（chat 装配 bag，形状不变）

`interpret(bag)` 的图数据与所有节点 bag 均由调用方（chat 入口 term）读出随 bag 传入；服务不读投影。
bag 带 `contract_version` 时门面校验主版本：不匹配立即拒绝并给 `contract_version_mismatch` 结构化结局（不派发执行）；
缺失视为未标注版本并兼容接受，事实记进摘要 `contract_version`（未标注为 null）。

```jsonc
{
  "graph": { "contracts": …, "nodes": …, "prompts": …, "graph": {…} | {"def":hash},
             "thresholds": …, "refusal_codes": … },   // 六类条目；链式 tail 经 refs 解析
  "refs": { "<def>": {…} },                          // 投影引用闭包（也接受 bag.graph_refs / bag.graph.refs）
  "pins": { "model": "model-protocol", … },          // 缺省回落宿主注入的 plugin.json 有效 pins
  "input" / "slots", "config", "tier", "session", "persona", "skills",
  "workspace_id" / "workspace_root", "todo", "guard_rules", "sandbox_tiers", "tools", …,
  "evolution": { version, trace:{tail,count}, evidence:…, proposals:…, verdicts:… },  // evolution 台账
  "resume": { "cursor": {…}, "thread": …, "payload": {…} }        // 裁决 / 作答续跑（带挂起游标）
          | { "continuation": true, "turn_id": "…" } | null,       // 段续跑（无游标，状态由步记录重建）
  "run": "…", "now": 0
}
```

`interpret` 返回 `{ $directives: [...] }`：节点写计划 + 回合尾账本写 + 摘要 `extern`（形状与拆分前一致）。
有回合身份时一段只跑一个 iter：段尾回合未完则摘要改标 `kind:'stepping'`、计划追加
`{kind:'eval', command:'chat.resume', args:{turn_id, thread, progress:{iter,node_index,contract_id}}, inject:{ids}}`，
由宿主在同一 run 内续跑；回合已完才收口。

## 数据身份（六类条目与种子回落）

| 条目            | 形状                                                                                                                                         | 空 body 回落                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `contracts`     | 链式 tail；能力边界（inputs / outputs / reads / publishes / pre / post / refuses / effects / cost）                                          | 十个种子契约                     |
| `nodes`         | 链式 tail；Scope 实例（atomic / composite、entry、bindings、autonomy、scope、links）                                                         | 十个种子实例                     |
| `prompts`       | 链式 tail / 对象映射；`system`（角色 + 沟通 / 执行 / 工具 / 安全四节）、`skill_select`                                                       | 种子提示词                       |
| `graph`         | **单值**（不是 tail）；nodes / edges / entry_supply / loop / sink / derived_from                                                             | 种子图                           |
| `thresholds`    | 链式 tail / 扁平 map / 条目数组；字段名契约与 evolve-metrics 对齐（见「阈值契约」）                                                          | `DEFAULT_THRESHOLDS`             |
| `refusal_codes` | 链式 tail（append-only）；`{code, retriable, attributable_to}`                                                                               | 十八码（append-only 合流）       |

图模型由本门面解析（`resolveModel`：空 body / 解析失败 / 图不可执行 ⇒ 回落包内种子图）后随 `graph-run.run` 传入；
账本组装所需的 `thresholds` / `refusal_codes` / 激活图随 `turn-ledger.settle` 传入。

## 图机械闸（消费 `graph-gate` 提供方）

机械闸由 `graph-gate` 提供方**权威实现**，本门面与下游经反向 `port.call` 消费，不本地复刻：
运行期结构闭合由 `graph-run` 调 `graph-gate.closure`（提供方不可用即 fail-closed 拒绝）；提案机械闸由
`turn-ledger` 调 `graph-gate.validate`。图数据随 bag 传入（服务不读投影）。

## 阈值契约（与 evolve-metrics 对齐）

本插件提供 `thresholds` 默认值，语义以 `evolve-metrics` README 阈值表为准，字段名逐项对齐：
`failure_cluster_n` / `post_failure_ratio` / `post_failure_min` / `cost_anomaly_multiple` / `drift_margin` /
`drift_min_samples` / `fold_k` / `no_progress_n` / `verify_failure_n` / `verify_cluster_ratio` / `min_workspaces` /
`trace_retention_rounds` / `evidence_retention_rounds` / `unhealthy_refused_streak`。
图 / 演化参数（本插件权威）：`max_turn_iter` / `max_steps` / `loop_repeat_n` / `loop_novelty_window` / `loop_novelty_min` / `gas` / `llm_chain_max` / `max_graph_diff` /
`min_runs_before_fork` / `max_links` / `graph_growth_quota` / `instance_growth_quota` / `shadow_rounds` /
`large_artifact_bytes` / `model_alias_pins`。解析后的扁平 thresholds map 随 `context.assemble` bag 下传（单一真源）。
运行期空转检测（**与 evolve 的 `no_progress_n` 无关**）：`loop_repeat_n` / `loop_novelty_window` / `loop_novelty_min`
由图执行引擎据「动作 + 观察 + 状态」签名做连续 / 周期 / 低新颖判定；首次命中先注入一次 nudge（前导系统消息），
再次命中才以 `stop_reason: no_progress` 收口；`loop.allow_tools` 可豁免轮询类工具。

## 跨段续跑与取消

- **段续跑**：`chat.resume` 只带 `turn_id`，`graph-run` 据会话步记录重建状态；服务不把整回合序列化进计划或游标。
- **取消**：`loop-policy.cancel` 转发给 `graph-run.cancel`；标志在回合终态清除，段终态保留，使落在两段之间的取消能拦住下一段入口。
  取消返回 `ended:'cancelled'`，不经 sink、不写拒绝产物；已完成的步骤内容已在回合日志里。

## 运行

```sh
npm test    # 协议级 + 单元测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
