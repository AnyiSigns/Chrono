# loop-policy（唯一的策略 / 图解释器）

**服务自驱的图解释器**：图执行住 `execute/`、`pre` / `post` / `when` 为服务内声明式规则、节点经反向调用
`port.call` 派发、每步记入回合尾 `trace.eff_log`。回合管道 + 图执行 + 审批 / 提问往返（跨 run 挂起 / 续跑）

- 回合尾写 trace / 队列项 / 提案扫描 + `agent.step` 失败的降级判定。图 / 策略住本身份的**数据世代 body**；
  六类条目（契约 / Scope / 提示词 / 图 / 阈值 / 拒绝码）；空 body 回落**包内种子图 / 默认阈值**。

* 能力类 / 方法：`loop-policy.interpret`（图执行；一次调用跑**一段 = 一个 iter**，段尾未完即返回自续跑 eval）、
  `loop-policy.cancel`（置取消标志；同为并发方法，才不会被在途 `interpret` 挡住）。`schema.method_timeouts` 只兜一段，
  整回合长度由预算阶梯与宿主轮数上限约束。
* `pins`（= **节点类型空间**）：`session` / `model` / `context` / `retrieval` / `compress` / `guard` / `approval` /
  `tools` / `router` / `evolve-metrics`。
* `needs`（跨身份依赖，一律 `mode:"one"`）：同 `pins` 各能力类 + 图机械闸 `graph-gate`。
* 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
* 运行时零 npm 依赖；服务不写链、不读投影、不 import 宿主 / 内核 / client；跨插件只走 `port.call`；`now` 取 `env.now`。
* **并发**：`interpret` 声明为 `concurrent_methods`（跨会话并发；会话内互斥落在 `session.turn_open` 的 CAS）。
  派发路径无跨调用可变状态：工具 → 提供者能力类的解析器按当次 `bag.tools` 惰性读取，随调用构造，不复用全局。
  并发 `interpret` 各用各的目录解析提供者，互不串台。

## 入口契约（chat 装配 bag）

`interpret(bag)` 的图数据与所有节点 bag 均由调用方（chat 入口 term）读出随 bag 传入；服务不读投影。
bag 带 `contract_version` 时校验主版本：不匹配立即拒绝并给 `contract_version_mismatch` 结构化结局（不逐键回落）；
缺失视为未标注版本并兼容接受，事实记进摘要 `contract_version`（未标注为 null）。

```jsonc
{
  "graph": { "contracts": …, "nodes": …, "prompts": …, "graph": {…} | {"def":hash},
             "thresholds": …, "refusal_codes": … },   // 六类条目；链式 tail 经 refs 解析
  "refs": { "<def>": {…} },                          // 投影引用闭包（也接受 bag.graph_refs / bag.graph.refs）
  "pins": { "model": "model-protocol", … },          // 缺省回落 plugin.json 的 pins
  "input" / "slots", "config", "tier", "memories", "session", "persona", "skills",
  "workspace_id" / "workspace_root", "todo", "guard_rules", "sandbox_tiers", "tools", …,
  "evolution": { version, trace:{tail,count}, evidence:…, proposals:…, verdicts:… },  // evolution 台账
  "resume": { "cursor": {…}, "thread": …, "payload": {…} }        // 裁决 / 作答续跑（带挂起游标）
          | { "continuation": true, "turn_id": "…" } | null,       // 段续跑（无游标，状态由步记录重建）
  "run": "…", "now": 0
}
```

`interpret` 返回 `{ $directives: [...] }`：按段序合并各节点返回的写计划 + 回合尾 trace 写 + 提案扫描写，
末尾一条 `extern` 摘要（`{ok, kind:'interpret', iters, steps, fell_back, graph, ended, lifecycle, progress, refused_at, branch_not_taken, instances}`），
交 chat 入口 term 作为顶层 `$directives` 上提。有回合身份时一段只跑一个 iter：段尾回合未完则摘要改标
`kind:'stepping'`、计划追加 `{kind:'eval', command:'chat.resume', args:{turn_id, thread, progress:{iter,node_index,contract_id}}, inject:{ids}}`
（`progress.iter` 取**下一段**序号，供 chat 在下一段 `chat.turn.started` 上广播、UI 轮次实时前进），
由宿主在同一 run 内续跑；回合已完才收口。

> **与 chat 静态管道等价口径**：等价指**写计划（`write` 子操作序列）+ 反向调用 eff 序列**一致
> （简单问答 = `context.build → model.chat → 回合尾 step.result`；内容步 + 终态 `turn_settle`）；`extern` 观测载荷不逐字节等价
> （本插件额外附回合尾摘要 extern），chat 静态管道另有的 reply extern 仍在合并结果中。

## 服务自驱解释器

1. **读图数据**：`resolveModel(bag.graph, refs)`；`graph` 单值缺失 / 空 / 引用未声明契约 ⇒ **回落种子图**（`fell_back:true`）。
2. **顺序推进（拓扑序）**：按 `topoOrder(graph)` 前推，节点身份仍是 `nodes` 数组下标（源必先于目标求值；
   节点数组未排序的合法 DAG 仍全跑）。节点 0 = 入口（`entry_supply`）；**推式条件边**——每条边 `when` 在源产出已求值后判定，
   只沿成立的边激活下游。
   - **入边端口 `binding_mode`**：`any` 端口 ≥1 触发即激活，**按声明序取首个**，其余触发边记 `branch_not_taken`；
     `all` 端口在 `required:true` 时全部边必须触发，`required!==true` 时允许零触发（输入缺省，条件是这些边的源都已求值——
     源从未求值即不可达，仍不激活）。
   - **分支互斥**：同一**输出端口**的出边是一次分支选择，至多一条可触发；>1 触发即编排错误，判 `redundant` 拒绝短路。
   - `summary.branch_not_taken` 为**精确分支核算**（本回合未被消费的边数，含 composite 子图边），与 sink 位置无关；
     trace 另带 `branches_not_taken` 明细（被击败边 + 节点 + 原因）。
3. **运行期轻量闭合（G6）**：进入迭代前跑廉价结构校验（未知契约 + `checkClosure`：边越界 / 环 / sink / required 未连等），
   非法即结构化拒绝（码取首个 gate 错误码，归因 `graph`），不静默误执行；完整六不变量 + 演化规则仍在 propose / validate 期。
4. **选实例**：先按 `scope` 过滤候选（`workspace` / `session` 必须 id 匹配；`global` 恒可见），
   再按确定性 tie-break `(隔离升序, 成功率下界降序, cost 升序, node_id 升序)` 取首。
5. **工具目录（`context.assemble` 前置）**：调用方未预置目录时经 `port.call` `tools.list`（带 `tools_bindings` / `mcp_tools`）
   取目录写进 `bag.tools`（模型上下文可见）与 `bag.directory`（`tool.dispatch` 复用同一目录）；空数组不再被当作「预建空目录」。
6. **pre → 派发 → post**：`pre` 不过 ⇒ `pre_unsat`（node）短路；`port.call` 传输失败 ⇒ `transport_failed`（node）；
   节点业务错误 ⇒ 原码或 `downstream_refusal`；`post` 不过 ⇒ 按 reason 取码：模型空产出 ⇒ `empty_output`（node，可重试），
   其余 ⇒ `capability_mismatch`（graph）。**可重试码**（`retriable:true`）在 `post_retry_max` 上限内**重跑本节点**，达上限才收口拒绝。
   拒绝一律**短路到 sink**（`trace.refused_at` 可还原：`{node_index, iter, code, attributable_to}`；composite 子图内拒绝另带
   `parent_index`）；拒绝路径把最后一步助手消息一并交 sink，本回合已产出的正文 / 推理 / 工具卡照常落盘（只补 `error` 码）。
7. **composite 运行期展开（G2）**：`impl:'composite'` 且带 `subgraph` 的实例不派发能力类，而是把 `subgraph`
   当独立子图**递归展开**——自己的 `nodes` / `edges` / `entry_supply` / `loop` / `sink`；实例选择沿用父 `scope` / `pins`；
   子图入口（下标 0）接收 composite 节点的入边输入；子图 sink 产出按声明 `outputs` 映射回该节点（全命中即投影、
   单输出缺名即整体包裹、多输出歧义 ⇒ `delegate_output_ambiguous`）。子图 `iter.outputs/inputs` 隔离、`rs.steps` 单调共享
   （`(turn_id,type,seq)` 全局唯一）；子图节点步记录带 `parent_index`（`instances` 三元组、`refused_at.parent_index`），
   `branch_not_taken` 含子图边。防失控：`max_subgraph_depth`（默认 8）⇒ `max_recur`，`gas` 预算 / `max_steps` ⇒ `subgraph_incomplete`（budget）。
   **边界（明写）**：子图内模型节点与父图共用 `RunState`（`messages` / `last_calls` / `shared`），不做第二份隔离；
   仅 `iter.outputs/inputs` 隔离。复杂子图含模型节点时按此口径。
8. **重入（跨段）**：段尾按 `Graph.loop.when` 判定；`question_pending` 优先 ⇒ 本段正常收口（不 loop）；
   派发过工具 / verify 失败 / `todo_incomplete` ⇒ 段尾落一条段标记步记录并返回自续跑 eval，下一段由步记录重建
   状态（`extra_messages` 由工具步记录重建，段标记步落段序号）。达 `max_turn_iter` / `max_steps` 仍要派发 ⇒
   用户预算主动停：已完成步骤保留，以 **`committed` + `stop_reason`**（`turn_iter` / `steps`）收口，先于宿主机械轮数上限生效。
   无回合身份（单测直调）时不分段，保持同步多 iter。
   - **步序号分配**：`nextStepSeq(rs)` 单调占据 `rs.steps`，commit 步 / 段标记 / 检查点均经此分配，
     `(turn_id,type,seq)` 唯一且与 sink 位置无关（不再用 `rs.steps + 1` 估算）。
9. **sink 延后收口**：sink 在每个 iter 内不执行，只在回合终止 / 拒绝短路的那一段执行一次 ⇒「回合尾一次写」
   （消息 + trace + 队列项 + 提案扫描），避免重复提交用户消息 / 清槽；段终态不写 trace，同回合的 trace 记录器
   在段间累积、settle 时一次写成（每回合一个 evolution 世代）。
10. **每步记 `trace.eff_log`**：`{step, iter, port, method, args_hash, result_hash, outcome}`（`outcome ∈ ok/error/transport_failed/cancelled`）；
    随 trace 写入世界（evolve-metrics shadow 配对的数据底座）。

## 六类条目与种子回落

| 条目            | 形状                                                                                                                                         | 空 body 回落                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`     | 链式 tail；能力边界（inputs / outputs / reads / publishes / pre / post / refuses / effects / cost）                                          | 十一个种子契约                                                                                                                           |
| `nodes`         | 链式 tail；Scope 实例（atomic / composite、entry、bindings、autonomy、scope、links）                                                         | 十一个种子实例                                                                                                                           |
| `prompts`       | 链式 tail / 对象映射；`system`（Markdown：角色 + 沟通 / 执行 / 工具 / 安全四节、安全节最高优先、只谈意图、**禁工具标识符**）、`skill_select` | 种子提示词                                                                                                                               |
| `graph`         | **单值**（不是 tail）；nodes / edges / entry_supply / loop / sink / derived_from                                                             | 种子图                                                                                                                                   |
| `thresholds`    | 链式 tail / 扁平 map / 条目数组；字段名契约见下                                                                                              | `DEFAULT_THRESHOLDS`                                                                                                                     |
| `refusal_codes` | 链式 tail（append-only）；`{code, retriable, attributable_to}`                                                                               | 十八码（含 `empty_output` 可重试；composite 新增 `max_recur` / `subgraph_incomplete` / `delegate_output_ambiguous` / `subgraph_reject`） |

## 种子图（七节点 / 十一入边）

```
assemble ──messages──▶ step ──tool_calls(非空)──▶ gate ──allow────▶ dispatch ──wrote_files──▶ verify ──report──▶ commit
                         └──message(空)──────────────────────────────────────────────────────────────────▶ commit
                                       gate ──escalate──▶ approval ──approved──▶ dispatch        gate ──deny──▶ commit(refusal)
                                                                     └──denied────────────────────────────────▶ commit(refusal)
```

- 简单问答 = `assemble → step → commit` 三步、**零额外调用**（加强不落在默认路径上）。
- 十一个种子契约含池词汇 `join` / `subagent` / `evolve.propose` / `recall` 与 `verify` 分档（`vf-noop` global + 可选 `vf-<ws>` workspace）；
  每个契约至少一个 `scope:global` 实例（不变量 6）。
- `verify` 默认选 `as-verify-noop`（返回 `{skipped:true}`、零成本）；配了 `bindings.command` 的 workspace 实例经 scope 过滤自动选中并真跑命令。
- 种子判定（服务内置求值器）：`nonempty` / `empty` / `eq` / `verdict_is` / `wrote_files` / `todo_incomplete` / `question_pending`
  - 重入复合式 `dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete`。
- 机械 `post` 四处（只做结构检查，输入面 = 本 Scope outputs/inputs/reads + thresholds + 本步 eff_log）：
  `assemble_post`（messages 非空 ∧ 末条 role ∈ user/tool/system ∧ params 为对象）、
  `step_post`（非空 ∧ 正文 / `tool_calls` 至少其一 ∧ `tool_calls` 结构合法；同帧带前言正文与工具调用合法）、
  `dispatch_post`（result 数 = call 数 ∧ 逐项 ok 布尔 ∧ 失败带 error.code）、
  `verify_post`（skipped 或 passed 布尔 + detail）。

## 图机械闸（消费 `graph-gate` 提供方）

机械闸（闭合 / 类型 / publish 偏序 / 端口 ⊆ pins + 六条不变量 + 四条演化规则）由 `graph-gate` 提供方**权威实现**，
本插件经反向 `port.call` 消费，不本地复刻：

- **运行期结构闭合**：`interpret` 入口与每个 composite 子图入口调 `graph-gate.closure`（未知契约 + 闭合检查）；
  提供方不可用时 fail-closed 拒绝（`graph_gate_unavailable`）。
- **提案机械闸**：回合尾提案扫描调 `graph-gate.validate`（图数据 / pins / active 图 / fork 计数随 args 传入）。
- 图数据随 bag 传入（服务不读投影）；结果哈希口径 `H({graph, pins, active_graph, runs_since_fork})`
  （键升序、剔 undefined、`-0→0`）。
- 契约声明：`plugin.json.needs.graph-gate`（`mode:"one"`）；实现与对拍用例住 `plugins/graph-gate`。
- 错误码：`no_nodes` / `edge_ref` / `cycle` / `sink` / `non_entry_isolated` / `no_path_to_sink` / `multiple_sinks` /
  `unconnected_input` / `unknown_port` / `type_mismatch` / `publish_order` / `port_not_pinned` /
  `missing_fallback_entry` / `missing_join_contract` / `missing_subagent_contract` / `approval_bypass` /
  `llm_chain_max` / `last_global_instance` / `unknown_contract` / `fork_only` / `diff_exceeded` / `min_runs_before_fork`。

## trace / eff_log 与审批 / 提问往返

- 回合尾写：`put(trace 条目) + put(新 evolution body: trace.tail=…, count+1) + add_gen('evolution')`（无 evolution 台账时不产轨迹写）。
  trace 条目含 `steps[]`（每步 `{node_index, iter, contract_id, chosen_instance, chosen_agent, verdict, refusal, post_failed, verify, usage, eff_log}`，
  子图步另带 `parent_index`）、
  聚合 `eff_log`、`refused_at`、`branch_not_taken`（本回合未被消费的边数：精确分支核算、0 计费）、
  `branches_not_taken`（被击败分支明细）、`link_taken`、`outcome`、`prev`。
- **审批往返**：`approval.wait` 派发前把游标放进 bag → `approval.enqueue` 产 item（带 `thread` 与
  `resume:{command:'chat.resume', args:{cursor, thread}}`）→ 本 run **正常返回**（`ended:'pending'`）；裁决后经
  `chat.resume`（`bag.resume`）恢复：置 `approval.wait` 产出 `{decision}` 后继续。
- **提问往返**：`tool.dispatch` 遇 `question` 工具 ⇒ 游标随 dispatch bag 交 question（item 落世界）⇒ `question_pending` 为真 ⇒
  本 run 正常结束（不 loop）；作答后经 `chat.resume` 恢复：把答案回灌为 question 工具结果、视作本 iter 派发过工具、追加工具消息后重入。
- **一次性 `caps.grant` 契约（本插件签发，sandbox 消费）**：裁决 `approved` 恢复派发时，按被批准的 call 构造
  `{call_id, op, paths, fs, net, tier, expires}` 随 `tool.dispatch` bag 下传（tools 透传 → 提供者 → sandbox），派发完成即从 bag 摘除
  （不泄漏到后续 iter）。**形状以实现为准**（`plugins/sandbox/execute/grant.rs` 消费 `bag.grant` / `bag.caps.grant`：
  `call_id` 必填；`op` 须等于本次 `fsop` op；目标路径须落在 `paths`（**空 = 不适用**）；`fs` 只声明本次 op 维度
  （未声明不放宽、不回落 full）；`net` 为 net 越档批准的范围（none/limited/all，消费一次）；`tier` 须等于当前档；
  `expires` 用帧 `env.now` 判；同 `call_id` 消费一次即拒）。
  `op` 映射（与 tool-fs 契约对齐）：`read→read` / `glob→list` / `grep→grep` / `stat→stat` / `edit→replace`（`old` 非空）/ `write`（`old` 空）；
  net 越档升级（`net_outside_tier`）且无 fs op 映射时补 `op:"exec"`，使 sandbox exec 能消费 net 放宽。
- **游标契约（本插件自造 opaque 结构，宿主不认识）**：`{kind:'approval'|'question'|'orchestration_change', iter, node_index,
outputs, inputs, executed, messages, extra_messages, slots, shared, dispatched_tools, question_pending, verify_failed, last_calls, steps, original_input, call_id?}`。
  `original_input` = 本轮 `bag.input`（原始用户消息）：作答 / 裁决时刻的槽已换成 `approval.decide` / `question.answer`，
  恢复时优先用它重建上下文。提问往返的游标在派发后重建（含同批其它工具真实结果）并替换进 question 队列项的 `resume`，
  恢复时只替换 question 项。**段续跑不走此游标**：只带 `turn_id`，状态由会话步记录重建。

## 提案扫描与采纳

回合尾读 evolution `proposals` 未决项（newest→oldest）→ `port.call graph-gate.validate`（机械闸）→ `port.call evolve-metrics.shadow`（零 token）→
`approval.wait` 产 `orchestration_change` 入 approval（item 带游标 + shadow 指标 def + `port:'orchestration-admin'`）→ 本 run 结束。
裁决续跑（`cursor.kind:'orchestration_change'`）：`approved` ⇒ 按 `patch.writes[]` 展开
`add_gen('loop-policy', 图 def)` + 各跨身份 `add_gen` + `accepted` verdict；`denied` ⇒ `rejected` verdict。
机械闸不过的提案直接落 `rejected` verdict（不入人闸）。`evolve.propose` Scope（LLM）产提案、**不产证据**，触发读**已落账** evolution evidence。

## 取消（协作式）

`cancel(turn_id)` 在进程内按回合置标志（幂等）；运行中的 `interpret` 在三个检查点查标志，命中即停、不派发：

1. **入口**（进入 iter 环之前）：标志已置时立即返回，不派发任何节点；
2. **每次节点派发前**（`runIter` 内的每个拓扑节点前）：模型调用与工具派发都在此闸后，命中即不开始本节点；
3. **每个节点派发后**（`dispatchNode` 返回、记录 eff 之后）：模型调用被 `model-protocol.abort` 中止、
   或派发期间置了标志时，丢弃产出、不短路成拒绝。

取消返回 `ended:'cancelled'`，不经 sink、不写拒绝产物；已完成的步骤内容已在回合日志里。取消的回合由
`session.turn_settle(cancelled)` 经 CAS 落定——若取消链路已先落定，本段迟到收口被 CAS 拒绝并记 `late_settles`
（僵尸段不得改写结局）。标志在**回合终态**（done / refused / cancelled / pending）清除；段终态（stepping）保留，
使落在两段之间的取消能拦住下一段入口。取消不回溯已落账（冻结层既定语义）。

## 降级判定

`agent.step`（`model` 端口）失败 ⇒ 规则判定是否降级 ⇒ `port.call router.select`（候选 = pins 主名 ∪ 别名；
别名 = `thresholds.model_alias_pins`，缺省空 ⇒ 机械 no-op）⇒ 以返回端口名再 `port.call` 备选实现；
无别名 / 传输失败 / 选中主名 ⇒ 不降级、按原码拒绝。`orchestration.unhealthy` 事件**由 evolve-metrics 发**（本插件不发）。

## 阈值契约（与 evolve-metrics 对齐）

本插件提供 `thresholds` 默认值，**语义以 `evolve-metrics` README 阈值表为准**，字段名逐项对齐（2026-09-21 双侧登记）：
`failure_cluster_n=3` / `post_failure_ratio=0.5` / `post_failure_min=3` / `cost_anomaly_multiple=2.0` /
`drift_margin=0.2` / `drift_min_samples=5` / `fold_k=3` / `no_progress_n=3` / `verify_failure_n=2` /
`verify_cluster_ratio=0.6` / `min_workspaces=2` / `trace_retention_rounds=50` / `evidence_retention_rounds=50` /
`unhealthy_refused_streak=3`。
图 / 演化参数（本插件权威）：`max_turn_iter` / `max_steps` / `gas` / `llm_chain_max` / `max_graph_diff` /
`min_runs_before_fork` / `max_links` / `graph_growth_quota` / `instance_growth_quota` / `shadow_rounds` /
`large_artifact_bytes` / `model_alias_pins`。`interpret` 把解析后的**扁平 thresholds map** 随 evolve-metrics bag 下传，
并随 `context.assemble` bag 下传（`bag.thresholds`）：`large_artifact_bytes` 等阈值以本插件为单一真源，
消费方 context-window 据此覆盖自身 policy 默认。

## 未决 / 偏离（明写）

- **chat bag / `bag.resume` 接口（已落地）**：`chat.send` / `chat.resume` 的入口 term 经自能力路由 eff `loop-policy.interpret`。
  本插件按 bag 装配契约定义并容错接受：`bag.input`（槽或归一）、`bag.slots`、`bag.refs`/`bag.graph_refs`、
  `bag.resume = {cursor, thread, payload}`（也接受 cursor 直接作 resume、`payload.verdict` 或 `resume.verdict`）。
- **context-window `extra_messages`（item 9，已下线生产下传）**：消费侧已改为从会话步日志
  （`session.turns[].steps`）投影、**明确忽略本键**（见 context-window `candidates.ts`）。本插件**生产路径默认不再**
  往 `context.assemble` bag 下传该键；仅当调用方显式 `bag.compat_extra_messages === true`（旧式调用 / 测试兼容）才下传，
  属惰性兼容键。展示 / 收口路径不读它（直接读 `rs.extraMessages`，见 `commit-parts.ts`），故展示 parts 不受影响。
  分段执行后进度**由本回合步记录重建**（`execute/reconstruct.ts`：每步 `step.intent` 给中性调用、`step.result.tool_results`
  给结果，`checkpoint({kind:verify|segment|subagent})` 给校验报告 / 子代理结论 / 段序号），不依赖服务进程内状态跨段存活。
  工具路径按**规范序列**回灌：先 `assistant` 承接帧（带中性 `tool_calls: [{id,name,arguments}]`），再逐条
  `tool` 结果（带 `tool_call_id` 与调用配对）。
- **中立推理持久化（item 8，已落地）**：模型产出里的厂商中立推理块（`reasoning_blocks[0]`，无则推理文本兜底块）随
  `step.result.reasoning` 落盘（顶层字段，非 `assistant`），使 context-window 跨段 / 跨回合按 `step.result.reasoning`
  回灌；展示 side 仍取 `assistant.parts` 的 `reasoning`（display 文本），两条通道互不影响。
- **用量 / 缓存提示转发（已落地）**：最近一次完成的模型调用用量（本段暂存，跨段由 `step.result` 重建）随
  `context.assemble` bag 的 `usage` 键下传，激活 context-window 的估算校准；`context.assemble` 回值里的
  中立 `cache` 提示原样转发进 `model.chat` bag 的 `cache` 键。两者都 absent-safe：来源缺失即不落键。
- **落盘展示 parts（已落地）**：`turn.commit` 把本轮时间线（承接帧 + 工具结果）折叠成有序展示段
  （`reasoning` / `text` / `tool`，见 `execute/commit-parts.ts`）写进 assistant 消息 `parts`，供 UI 定稿后
  仍能渲染推理块与工具卡（含 render 描述符与结果）。纯展示数据，不进模型上下文：context-window 丢弃
  `reasoning` / `tool` part，工具可见性仍由上面的 `extra_messages` 回灌保证。纯文本回合不写 parts。
- **sink 延后收口**：契约字面为每个 iter 都到 `commit`；本实现将 sink 延后到 loop 终止 / 拒绝短路时执行一次，
  以保「回合尾一次写」且不重复提交用户消息 / 清槽。属对契约的解释性收敛，已在 README 登记。
- **`post` 失败码**：`step_post` 的「模型空产出（无正文、无工具调用）」用独立可重试码 `empty_output`（node，按 `post_retry_max` 重跑本步）；其余 Scope 产出不合契约仍用 `capability_mismatch`（graph，不可重试）。
- **拒绝码表 append-only 合流**：解析图数据时保留图上已有码，并补进包内种子新增码（老图无需重 seed 即获新码）。
- **不变量 4 写期判据**：图数据无工具名，故写期按端口名 + **声明式写档 `caps.fs.write`** 机械近似；更精确的
  `(port, tool)` 判据归运行时（`guard.judge` 逐 call）。composite 子图递归生效。
- **子代理隔离（已落地）**：`subagent` 契约派发时不经父消息历史，改用**任务 + 父检查点**的专用 bag
  （`execute/subagent.ts`）：任务取 `inputs.task` > `bag.task` > `bag.input`；父检查点取本回合最后一条结构化
  `checkpoint` 步记录（同回合内委派场景）。模型产出归一为**结构化结果**（`goal` / `findings` / `files` /
  `open_questions` 等，与 `checkpoint.summary` 同形），并被 `toSubagentResult` 落成 `checkpoint` 步记录，
  父回合只吸收蒸馏结论而非子代理全程记录——长任务里这是最便宜的上下文节省。子代理模型调用随附
  `thread_kind:'subagent'` 与 `parent_checkpoint`；`context.assemble` 侧对 subagent 线程不组装父消息历史。
  子代理模型调用另渲染本线程未读收件箱 `bag.inbox_unread`（`[收件箱 kind · 来自 from]\nbody`，按声明序＝
  `seq` 升序；`assembleBag` 也把该键透传给 context-window，供 main / 其它线程组装口径消费）。
  **边界**：跨线程委派（父检查点在另一会话的回合里）需调用方把 `parent_checkpoint` 随 bag 传入，本插件在
  同回合内自取。
- **`join` / `recall` 为词汇占位**：`join` 是纯函数（同键取最新，不发 eff）；`recall` 只作契约 / 实例词汇，**不进默认图**。
  检索已改为**模型可调工具**（工具绑定归 `tools`），默认路径不自动召回；常驻只留工作区 L2（由 context-window 装配）。
  `retrieval.search` bag 的权威键名已冻结并双向对齐（`workspace` / `recall_budget` / `query`），见
  `chain-contract/README.md` 与 `tests/contract/loop-policy-retrieval.seam.contract.test.mjs`。
- **段边界检查点（本插件触发）**：每段收束、回合未完时读本段 `context.assemble` 清单的 `used / budget`，
  越阈即经 `port.call compress.summarize`（`algorithmic`、`persist:false`）产出结构化摘要，追加一条
  `checkpoint` 步记录作为新的历史基础（`facts` 映射成 `findings`，`covered_upto` = 已落步序号）。
  档位阈值 `checkpoint_soft_ratio=0.7` / `checkpoint_hard_ratio=0.85` / `checkpoint_emergency_ratio=0.95`
  住本插件阈值（`bag.checkpoint_thresholds` 可按调用覆盖）；75% 提示仍是 context-window 的辅助信号。
  **压缩失败不阻断回合**：跳过记录、照常续段，段标记与自续跑不受影响。
- **游标落世界**：挂起 / 续跑（审批 / 提问 / 编排变更）仍把当前 iter 的图位置与调用状态序列化进队列项游标
  （`node_index` / `outputs` / `messages` 等，opaque，宿主不认识）；这类续跑是段内恢复，必须带图位置。
  **段续跑不同**：`chat.resume` 只带 `turn_id`，解释器据步记录重建状态，服务不把整回合序列化进计划或游标。
- **`caps.grant` 的维度合并（G8，已落地）**：批准后 grant 绑定**决策序首个可解析的升级 call**
  （无升级项时回落批内首个 call），但把**整批所有升级裁决**的维度并集并入这一份：`fs`（读写维度并集）、
  `paths`（声明序去重）、`net`（取最宽范围）、`op`（首个 fs 映射；net 越档且无 fs 映射时补 `exec`）。
  故「首个升级项不是 net」也不会丢 net 放宽。**v1 边界**：单份 grant 只对绑定的 `call_id` 生效，
  整批多个 call 各自升级时，其它 call 由 sandbox 侧按同一 grant 判定（跨 call 批量授权的登记项见后续）；
  `edit` 新建（`old` 空）先 `stat`（op=`read`）再 `write`（op=`write`）时 grant 只绑定 `write`（与
  `plugins/tool-fs/README.md`「区外新建」已知限制一致）。

## 运行

```sh
npm test                    # 协议级 + 单元测试（node --test）
node tools/e2e-smoke.mjs    # 宿主装配 E2E（pack 闭包 → seed → 离线投影 → 直连协议 → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
