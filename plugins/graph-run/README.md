# graph-run（图执行引擎）

图执行引擎：**运行期结构闭合 + 拓扑前推 + 节点派发 + 拒绝短路 + 跨段重入 + 取消**。
图数据、解析后的图模型、`pins` / `refs` / 续跑依据随 `args` 传入（服务**不读投影**）；
节点经反向调用 `port.call` 派发；回合尾 trace / 提案账本归 `turn-ledger`。
上游 `loop-policy` 作为门面持有公开方法面与数据身份，执行委派到本提供方（消费方零改动）。

- 身份：`graph-run`
- 能力类 / 方法：`graph-run` → `run`（一次调用跑**一段 = 一个 iter**，段尾未完则返回自续跑计划）、`cancel`（置取消标志）
- `pins`：无（`"pins": {}`）；`needs`：`session` / `model` / `context` /
  `guard` / `graph-gate` / `approval` / `tool-registry` / `tool-dispatch` / `router`（`mode:"one"`），
  以及 `context-source`（`mode:"many"`，`methods:["collect"]`）——`context.assemble` 前置的通用汇集扩展点
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖；服务不写链、不读投影；跨插件只走 `port.call`；`now` 取 `env.now`

## 方法

| 方法     | 入参                                                                 | 返回                                                                                                                            |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `run`    | `{bag, model, pins?, refs?, resume?}`                                 | `{directives, events, pending, summary, ended, lifecycle, progress, stop_reason, trace}`                                         |
| `cancel` | `{turn_id}`                                                           | `{ok, turn_id, cancelled}`                                                                                                      |

- `run` 的 `model` 是**已解析**的图模型 `{contracts,nodes,prompts,graph,thresholds,refusalCodes}`（种子回落归 `loop-policy`）。
- `trace` 是 trace 的纯数据事实 `{steps,eff_log,refused_at,branch_not_taken,branches_not_taken,link_taken,outcome}`，
  供 `turn-ledger.settle` 在另一进程组装 trace 条目（服务不共享进程内对象）。
- `run` 有 `turn_id` 时**一段 = 一个 iter**：段尾回合未完即返回计划含续跑 `eval`；无回合身份时保持同步多 iter。
- `cancel` 与 `run` 同为并发方法：运行中的 `run` 在三个检查点查标志（入口 / 每次派发前 / 派发后），命中即停。

## 执行口径

1. **运行期轻量闭合（G6）**：进入迭代前经 `graph-gate.closure` 做未知契约 + 闭合检查；提供方不可用时 fail-closed 拒绝。
2. **顺序推进（拓扑序）**：推式条件边——每条边 `when` 在源产出后判定；入边端口 `any` / `all` 绑定语义；
   同一输出端口至多一条触发分支（>1 ⇒ `redundant`）。
3. **选实例**：按 `scope` 过滤 + 确定性 tie-break（隔离升序 / 成功率下界降序 / cost 升序 / node_id 升序）。
4. **pre → 派发 → post**：`pre` 不过 ⇒ `pre_unsat`（node）；传输失败 ⇒ `transport_failed`；节点业务错误 ⇒ 原码或
   `downstream_refusal`；`post` 不过 ⇒ 模型空产出 `empty_output`（可重试）其余 `capability_mismatch`。
   节点 bag 装配与结果归一由契约的 `bag_pick` / `output_map` / `dispatch` 元数据声明，派发器按声明机械执行（不按 `contract_id` 分支）：轻节点转发 `bag_pick` 键并叠加命名派生字段，重节点用命名 bag 规则，归一用命名规则。
5. **composite 子图运行期展开**：自己的 `nodes` / `edges` / `entry_supply` / `loop` / `sink`；防失控：`max_subgraph_depth` / `gas` / `max_steps`。
6. **sink 延后收口**：sink 只在回合终止 / 拒绝短路的那一段执行一次（「回合尾一次写」）。
7. **跨段重入**：段尾按 `Graph.loop.when` 判定；有回合身份时自续跑 `chat.resume`（状态由步记录重建）。
8. **空转检测（升级阶梯）**：段尾对「动作 + 观察（工具结果）+ 状态增量」的**内容摘要**（sha256，只留摘要不留正文）做连续重复 / 短周期交替 / 低新颖判定；
   首次命中注入一次 nudge（`bag.loop_nudge`，前导系统消息）提示换策略，再次命中才 `stopTerminal('no_progress')`。
   阈值 `loop_repeat_n` / `loop_novelty_window` / `loop_novelty_min`；`loop.allow_tools` 声明的轮询类工具豁免。
9. **取消（协作式）**：命中标志即停、不派发、不写拒绝产物；终态由属主 CAS 落定。
10. **`context.assemble` 前置通用汇集**：派发 `context.build` 前先按世界 `context-source` 成员表（身份名码元序）
    逐一反向 `collect(bag)`，把各成员返回的 `{records:[…]}` 汇总为 `bag.context_sources` 下传；成员不可用只跳过，
    零成员合法。加减一个来源只改世界成员表，本插件与 `context-window` 不改。

## 边界

- 不做：回合尾 trace 落账 / 提案扫描与采纳 / 会话收口（归 `turn-ledger` 与 `loop-policy`）；图模型解析与种子回落（归 `loop-policy`）。
- 不读投影、不写链；不取时间 / 随机（`now` 取 `env.now`）；同输入同输出。
- 服务不 import 宿主与内核；跨身份只走 `port.call`。

## 运行

```sh
npm test    # 协议级 + 单元测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
