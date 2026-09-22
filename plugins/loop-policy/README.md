# loop-policy（唯一的策略 / 图解释器）

**服务自驱的图解释器**：图执行住 `execute/`、`pre` / `post` / `when` 为服务内声明式规则、节点经反向调用
`port.call` 派发、每步记入回合尾 `trace.eff_log`。回合管道 + 图执行 + 审批 / 提问往返（跨 run 挂起 / 续跑）
+ 回合尾写 trace / 队列项 / 提案扫描 + `agent.step` 失败的降级判定。图 / 策略住本身份的**数据世代 body**；
六类条目（契约 / Scope / 提示词 / 图 / 阈值 / 拒绝码）；空 body 回落**包内种子图 / 默认阈值**。

- 能力类 / 方法：`loop-policy.interpret`（唯一方法；`schema.method_timeouts` 覆盖整回合等待上限）。
- `pins`（= **节点类型空间**）：`session` / `model` / `context` / `retrieval` / `guard` / `approval` / `tools` /
  `router` / `evolve-metrics`。
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖；服务不写链、不读投影、不 import 宿主 / 内核 / client；跨插件只走 `port.call`；`now` 取 `env.now`。

## 入口契约（chat 装配 bag）

`interpret(bag)` 的图数据与所有节点 bag 均由调用方（chat 入口 term）读出随 bag 传入；服务不读投影。

```jsonc
{
  "graph": { "contracts": …, "nodes": …, "prompts": …, "graph": {…} | {"def":hash},
             "thresholds": …, "refusal_codes": … },   // 六类条目；链式 tail 经 refs 解析
  "refs": { "<def>": {…} },                          // 投影引用闭包（也接受 bag.graph_refs / bag.graph.refs）
  "pins": { "model": "model-protocol", … },          // 缺省回落 plugin.json 的 pins
  "input" / "slots", "config", "tier", "memories", "session", "persona", "skills",
  "workspace_id" / "workspace_root", "todo", "guard_rules", "sandbox_tiers", "tools", …,
  "evolution": { version, trace:{tail,count}, evidence:…, proposals:…, verdicts:… },  // evolution 台账
  "resume": { "cursor": {…}, "thread": …, "payload": {…} } | null,                    // 跨 run 续跑
  "run": "…", "now": 0
}
```

`interpret` 返回 `{ $directives: [...] }`：按段序合并各节点返回的写计划 + 回合尾 trace 写 + 提案扫描写，
末尾一条 `extern` 摘要（`{ok, kind:'interpret', iters, steps, fell_back, graph, ended, refused_at, branch_not_taken, instances}`），
交 chat 入口 term 作为顶层 `$directives` 上提。

> **与 chat 静态管道等价口径**：等价指**写计划（`write` 子操作序列）+ 反向调用 eff 序列**一致
> （简单问答 = `context.build → model.chat → session.commit`）；`extern` 观测载荷不逐字节等价
> （本插件额外附回合尾摘要 extern），chat 静态管道另有的 reply extern 仍在合并结果中。

## 服务自驱解释器

1. **读图数据**：`resolveModel(bag.graph, refs)`；`graph` 单值缺失 / 空 / 引用未声明契约 ⇒ **回落种子图**（`fell_back:true`）。
2. **顺序推进**：拓扑序前推；节点 0 = 入口（`entry_supply`）；**推式条件边**——每条边 `when` 在源产出已求值后判定，
   只沿成立的边激活下游；入边端口按 `binding_mode`（`all` AND 汇聚 / `any` 恰一）激活。
3. **选实例**：先按 `scope` 过滤候选（`workspace` / `session` 必须 id 匹配；`global` 恒可见），
   再按确定性 tie-break `(隔离升序, 成功率下界降序, cost 升序, node_id 升序)` 取首。
4. **工具目录（`context.assemble` 前置）**：调用方未预置目录时经 `port.call` `tools.list`（带 `tools_bindings` / `mcp_tools`）
   取目录写进 `bag.tools`（模型上下文可见）与 `bag.directory`（`tool.dispatch` 复用同一目录）；空数组不再被当作「预建空目录」。
5. **pre → 派发 → post**：`pre` 不过 ⇒ `pre_unsat`（node）短路；`port.call` 传输失败 ⇒ `transport_failed`（node）；
   节点业务错误 ⇒ 原码或 `downstream_refusal`；`post` 不过 ⇒ `capability_mismatch`（graph）。
   拒绝一律**短路到 sink**（`trace.refused_at` 可还原：`{node_index, iter, code, attributable_to}`）。
6. **重入**：回合尾按 `Graph.loop.when` 判定；`question_pending` 优先 ⇒ 本 run 正常结束（不 loop）；
   派发过工具 / verify 失败 / `todo_incomplete` ⇒ 继续 loop。达 `max_turn_iter` / `max_steps` 仍要派发 ⇒ 落 **`budget`** 码（不静默截断）。
7. **sink 延后收口**：sink 在每个 iter 内不执行，只在 loop 终止 / 拒绝短路时执行一次 ⇒「回合尾一次写」
   （消息 + trace + 队列项 + 提案扫描），避免重复提交用户消息 / 清槽。
8. **每步记 `trace.eff_log`**：`{step, iter, port, method, args_hash, result_hash, outcome}`（`outcome ∈ ok/error/transport_failed/cancelled`）；
   随 trace 写入世界（evolve-metrics shadow 配对的数据底座）。

## 六类条目与种子回落

| 条目 | 形状 | 空 body 回落 |
| --- | --- | --- |
| `contracts` | 链式 tail；能力边界（inputs / outputs / reads / publishes / pre / post / refuses / effects / cost） | 十一个种子契约 |
| `nodes` | 链式 tail；Scope 实例（atomic / composite、entry、bindings、autonomy、scope、links） | 十一个种子实例 |
| `prompts` | 链式 tail / 对象映射；`system`（行为准则 + 产品事实、只谈意图、**禁工具标识符**）、`skill_select` | 种子提示词 |
| `graph` | **单值**（不是 tail）；nodes / edges / entry_supply / loop / sink / derived_from | 种子图 |
| `thresholds` | 链式 tail / 扁平 map / 条目数组；字段名契约见下 | `DEFAULT_THRESHOLDS` |
| `refusal_codes` | 链式 tail（append-only）；`{code, retriable, attributable_to}` | 十三码 |

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
  + 重入复合式 `dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete`。
- 机械 `post` 四处（只做结构检查，输入面 = 本 Scope outputs/inputs/reads + thresholds + 本步 eff_log）：
  `assemble_post`（messages 非空 ∧ 末条 role ∈ user/tool/system ∧ params 为对象）、
  `step_post`（非空 ∧ 恰有其一 ∧ tool_calls 结构合法）、
  `dispatch_post`（result 数 = call 数 ∧ 逐项 ok 布尔 ∧ 失败带 error.code）、
  `verify_post`（skipped 或 passed 布尔 + detail）。

## 机械闸（**权威实现**）

`execute/gate.ts` + `execute/invariants.ts`：闭合（`no_nodes` / `edge_ref` / `cycle` / `sink` / `non_entry_isolated` /
`no_path_to_sink` / `multiple_sinks` / `unconnected_input`）、类型（`unknown_port` / `type_mismatch`）、
publish 偏序（`publish_order`）、端口 ⊆ pins（`port_not_pinned`）、
六条不变量（`missing_fallback_entry` / `missing_join_contract` / `missing_subagent_contract` / `approval_bypass` /
`llm_chain_max` / `last_global_instance` / `unknown_contract`）、
四条演化规则（`fork_only` / `diff_exceeded` / `min_runs_before_fork`）。
结果哈希口径 `H({graph, pins, active_graph, runs_since_fork})`（键升序、剔 undefined、`-0→0`）。

**与 orchestration-admin 对拍（2026-09-21 已完成）**：`test/parity.test.mjs` 对同一 bag 同时跑权威 `validateGraphData` 与 orchestration-admin
`validateBag`，逐项断言规则 / 错误码 / 结果哈希一致。对拍修正一处口径：不变量 4 的写档 fs 判据改为**声明式**
（显式声明 `caps.fs.write` 非 `'none'` 才算高危，且在 `effects.ports` 之外也据 `caps.fs.write` 判定，使
`tool.dispatch`（端口 `tools`、写档）受约束，与 #33 契约一致）。已同步修正 `plugins/orchestration-admin/**`
并在两处 README 登记。

## trace / eff_log 与审批 / 提问往返

- 回合尾写：`put(trace 条目) + put(新 evolution body: trace.tail=…, count+1) + add_gen('evolution')`（无 evolution 台账时不产轨迹写）。
  trace 条目含 `steps[]`（每步 `{node_index, iter, contract_id, chosen_instance, chosen_agent, verdict, refusal, post_failed, verify, usage, eff_log}`）、
  聚合 `eff_log`、`refused_at`、`branch_not_taken`（未求值 Scope 聚合计数、0 计费）、`link_taken`、`outcome`、`prev`。
- **审批往返**：`approval.wait` 派发前把游标放进 bag → `approval.enqueue` 产 item（带 `thread` 与
  `resume:{command:'chat.resume', args:{cursor, thread}}`）→ 本 run **正常返回**（`ended:'pending'`）；裁决后经
  `chat.resume`（`bag.resume`）恢复：置 `approval.wait` 产出 `{decision}` 后继续。
- **提问往返**：`tool.dispatch` 遇 `question` 工具 ⇒ 游标随 dispatch bag 交 question（item 落世界）⇒ `question_pending` 为真 ⇒
  本 run 正常结束（不 loop）；作答后经 `chat.resume` 恢复：把答案回灌为 question 工具结果、视作本 iter 派发过工具、追加工具消息后重入。
- **一次性 `caps.grant` 契约（本插件签发，sandbox 消费）**：裁决 `approved` 恢复派发时，按被批准的 call 构造
  `{call_id, op, paths, fs, tier, expires}` 随 `tool.dispatch` bag 下传（tools 透传 → 提供者 → sandbox），派发完成即从 bag 摘除
  （不泄漏到后续 iter）。**形状以实现为准**（`plugins/sandbox/execute/grant.rs` 消费 `bag.grant` / `bag.caps.grant`：
  `call_id` 必填；`op` 须等于本次 `fsop` op；目标路径须落在 `paths`（**空 = 不适用**）；`fs` 只声明本次 op 维度
  （未声明不放宽、不回落 full）；`tier` 须等于当前档；`expires` 用帧 `env.now` 判；同 `call_id` 消费一次即拒）。
  `op` 映射（与 tool-fs 契约对齐）：`read→read` / `glob→list` / `grep→grep` / `edit→replace`（`old` 非空）/ `write`（`old` 空）。
- **游标契约（本插件自造 opaque 结构，宿主不认识）**：`{kind:'approval'|'question'|'orchestration_change', iter, node_index,
  outputs, inputs, executed, messages, extra_messages, slots, shared, dispatched_tools, question_pending, verify_failed, last_calls, steps, original_input, call_id?}`。
  `original_input` = 本轮 `bag.input`（原始用户消息）：作答 / 裁决时刻的槽已换成 `approval.decide` / `question.answer`，
  恢复时优先用它重建上下文。提问往返的游标在派发后重建（含同批其它工具真实结果）并替换进 question 队列项的 `resume`，
  恢复时只替换 question 项。

## 提案扫描与采纳

回合尾读 evolution `proposals` 未决项（newest→oldest）→ 本地机械闸 → `port.call evolve-metrics.shadow`（零 token）→
`approval.wait` 产 `orchestration_change` 入 approval（item 带游标 + shadow 指标 def + `port:'orchestration-admin'`）→ 本 run 结束。
裁决续跑（`cursor.kind:'orchestration_change'`）：`approved` ⇒ 按 `patch.writes[]` 展开
`add_gen('loop-policy', 图 def)` + 各跨身份 `add_gen` + `accepted` verdict；`denied` ⇒ `rejected` verdict。
机械闸不过的提案直接落 `rejected` verdict（不入人闸）。`evolve.propose` Scope（LLM）产提案、**不产证据**，触发读**已落账** evolution evidence。

## 降级判定

`agent.step`（`model` 端口）失败 ⇒ 规则判定是否降级 ⇒ `port.call router.select`（候选 = pins 主名 ∪ 别名；
别名 = `thresholds.model_alias_pins`，缺省空 ⇒ 机械 no-op）⇒ 以返回端口名再 `port.call` 备选实现；
无别名 / 传输失败 / 选中主名 ⇒ 不降级、按原码拒绝。`orchestration.unhealthy` 事件**由 evolve-metrics 发**（本插件不发）。

## 阈值契约（与 evolve-metrics 对齐）

本插件提供 `thresholds` 默认值，**语义以 `evolve-metrics` README 阈值表为准**，字段名逐项对齐（2026-09-21 双侧登记）：
`failure_cluster_n=3` / `post_failure_ratio=0.5` / `post_failure_min=3` / `cost_anomaly_multiple=2.0` /
`drift_margin=0.2` / `drift_min_samples=5` / `fold_k=3` / `no_progress_n=3` / `verify_failure_n=2` /
`verify_cluster_ratio=0.6` / `min_workspaces=2` / `trace_retention_rounds=50` / `unhealthy_refused_streak=3`。
图 / 演化参数（本插件权威）：`max_turn_iter` / `max_steps` / `gas` / `llm_chain_max` / `max_graph_diff` /
`min_runs_before_fork` / `max_links` / `graph_growth_quota` / `instance_growth_quota` / `shadow_rounds` /
`large_artifact_bytes` / `model_alias_pins`。`interpret` 把解析后的**扁平 thresholds map** 随 evolve-metrics bag 下传。

## 未决 / 偏离（明写）

- **chat bag / `bag.resume` 接口（已落地）**：`chat.send` / `chat.resume` 的入口 term 经自能力路由 eff `loop-policy.interpret`。
  本插件按 bag 装配契约定义并容错接受：`bag.input`（槽或归一）、`bag.slots`、`bag.refs`/`bag.graph_refs`、
  `bag.resume = {cursor, thread, payload}`（也接受 cursor 直接作 resume、`payload.verdict` 或 `resume.verdict`）。
- **context-window `extra_messages` 为登记项**：同一 `interpret` 内 iter 间产物（工具结果 / verify 报告 / 提问答案）经服务内存
  `extra_messages` 随 `context.assemble` bag 传入，需 context-window 在 `bag` 接受该键并追加到 messages 尾部（未改 context-window，仅登记）。
- **sink 延后收口**：契约字面为每个 iter 都到 `commit`；本实现将 sink 延后到 loop 终止 / 拒绝短路时执行一次，
  以保「回合尾一次写」且不重复提交用户消息 / 清槽。属对契约的解释性收敛，已在 README 登记。
- **`post` 失败码**：全局拒绝码表无独立 post 码，本插件用 `capability_mismatch`（graph）承载「Scope 产出不合契约」。
- **不变量 4 写期判据**：图数据无工具名，故写期按端口名 + **声明式写档 `caps.fs.write`** 机械近似；更精确的
  `(port, tool)` 判据归运行时（`guard.judge` 逐 call）。composite 子图递归生效。
- **`join` / `recall` 为词汇占位**：`join` 是纯函数（同键取最新，不发 eff）；`recall` 的 `retrieval.search` bag 形状为
  初版约定，待 memory-retrieval 接口冻结后对齐。
- **游标落世界**：跨 run 续跑必须把服务进程内状态序列化进队列项游标（`outputs` / `messages` 等），大回合游标较大；
  v1 以正确性优先，未做压缩 / 引用化。
- **`caps.grant` 的两处 v1 边界（明写）**：① `bag.grant` 是单值，整批升级只绑定首个升级 call（按 call 拆批为后续登记项）；
  ② `edit` 新建（`old` 空）先 `stat`（op=`read`）再 `write`（op=`write`），grant 只绑定 `write`，区外 `stat` 仍可能被档位拒
  （与 `plugins/tool-fs/README.md`「区外新建」已知限制一致）。

## 运行

```sh
npm test                    # 协议级 + 单元测试（node --test，56 例）
node tools/e2e-smoke.mjs    # 宿主装配 E2E（pack 闭包 → seed → 离线投影 → 直连协议 → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
