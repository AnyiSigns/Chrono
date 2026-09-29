# graph-gate（图机械闸原语）

图数据的**纯机械面**：机械闸校验（闭合 / 类型 / publish 偏序 / 端口 ⊆ pins + 六条图不变量 + 四条演化规则）、
运行期结构闭合、实例确定性选择、内核口径内容哈希。图数据随 `args` 传入（服务**不读投影**），
供上游 `loop-policy`（解释器入口闭合 + 提案机械闸）与 `orchestration-admin`（`validate` / `propose`）经反向
`port.call` 消费；自身无反向调用、无写通道、不发 eff。

- 身份：`graph-gate`
- 能力类 / 方法：`graph-gate` → `validate` / `closure` / `select` / `hash`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`graph-gate.json`）
- `pins` / `needs`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态；同输入同输出、不取时间 / 随机）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`graph-gate.validate`
- 运行时零 npm 依赖（只用 Node 内置模块）

## 方法

| 方法       | 入参                                                      | 返回                        | 行为                                                                                              |
| ---------- | --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `validate` | `{graph, pins?, active_graph?, runs_since_fork?, refs?}`  | `{ok, errors, result_hash}` | 跑完整机械闸；`ok` = 错误列表为空；`result_hash` = `H({graph,pins,active_graph,runs_since_fork})` |
| `closure`  | `{graph, refs?}`                                          | `{ok, errors, view}`        | 运行期廉价结构校验：图内契约必须已声明 + 闭合检查；`view = {n, sink, order}`（图不可解析为 null） |
| `select`   | `{graph, contract_id, workspace_id?, session_id?, refs?}` | `{ok, instance \| error}`   | 同契约多实例按 `scope` 过滤 + 确定性 tie-break 取首；无候选 `instance` 为 null                    |
| `hash`     | `{value}`                                                 | `{hash}`                    | 对 `value` 做内核口径 `H`（hex sha256）                                                           |

### 机械闸错误码

| 码                          | 来源        | 含义                                                      |
| --------------------------- | ----------- | --------------------------------------------------------- |
| `no_nodes`                  | 闭合        | 图至少需要一个节点                                        |
| `edge_ref`                  | 闭合        | 边端点越界或形态非法                                      |
| `cycle`                     | 闭合        | 图有环（必须 DAG）                                        |
| `sink`                      | 闭合        | sink 不是合法 `node_index`                                |
| `non_entry_isolated`        | 闭合        | 非首节点无入边                                            |
| `no_path_to_sink`           | 闭合        | 节点无向路径到 sink                                       |
| `multiple_sinks`            | 闭合        | 除 sink 外存在无出边节点                                  |
| `unconnected_input`         | 闭合        | required 输入端口未连（入口可由 `entry_supply` 满足）     |
| `unknown_port`              | 类型        | 边的源 / 目标端口不存在                                   |
| `type_mismatch`             | 类型        | 源输出类型与目标输入类型不兼容                            |
| `publish_order`             | 偏序        | 同键发布者无拓扑偏序                                      |
| `port_not_pinned`           | 端口 ⊆ pins | `effects.ports` / `entry.cap` 不在 pins 里                |
| `missing_fallback_entry`    | 不变量 1    | 池中缺只依赖 entry_supply 的 `touches_effects:false` 契约 |
| `missing_join_contract`     | 不变量 2    | 缺 join 契约                                              |
| `missing_subagent_contract` | 不变量 3    | 缺 subagent 契约                                          |
| `approval_bypass`           | 不变量 4    | 高危端口节点可达路径缺 guard→approval 段                  |
| `llm_chain_max`             | 不变量 5    | 连续 LLM Scope 数超过 `llm_chain_max`                     |
| `last_global_instance`      | 不变量 6    | 契约缺 `scope:global` 实例                                |
| `unknown_contract`          | 不变量 6    | 图内契约未声明                                            |
| `fork_only`                 | 演化 1      | 新图必须带 `derived_from`（fork-only，禁空白整图）        |
| `diff_exceeded`             | 演化 2      | 结构改动超过 `max_graph_diff`                             |
| `min_runs_before_fork`      | 演化 3      | 攒够 `min_runs_before_fork` 回合才能作为下次 fork 基      |
| `graph_missing`             | 入口        | 缺图数据（`graph`）                                       |

## 入参（`args`）

```jsonc
// validate：图数据 bag 与 pins / active 图 / fork 计数
{
  "graph": { "contracts": [], "nodes": [], "prompts": {}, "graph": { "nodes": [], "edges": [], "sink": 0 }, "thresholds": {}, "refusal_codes": [] },
  "pins": { "model": "model-protocol" },
  "active_graph": null,
  "runs_since_fork": null,
  "refs": {}
}

// closure：同上 graph（+ refs）
{ "graph": { /* 六类条目包装，或含 def 引用的切片 */ }, "refs": {} }

// select：目标契约 id 与隔离上下文
{ "graph": { /* … */ }, "contract_id": "agent.step", "workspace_id": "w1", "session_id": null }

// hash：任意待哈希值
{ "value": { "nodes": ["a", "b"], "sink": 1 } }
```

- 缺 `graph`：`validate` / `closure` 回 `graph_missing`（`ok:false`）；`select` 回 `{ok:false, error:{code:"graph_missing"}}`。
- `select` 缺 `contract_id`：结构化 `bad_args`；契约未声明回 `{ok:false, error:{code:"contract_not_found"}}`。
- `hash` 缺 `value`：结构化 `bad_args`。
- 链式条目（`{tail,count}`）与 `refs` 闭包：由 `refs` 解析；已解析数组直接使用。

## 结果

- `validate`：`{ok, errors, result_hash}`——错误码与 `result_hash` 与拆分前逐字节一致（对拍口径见 `test/gate.test.mjs`）。
- `closure`：`{ok, errors, view}`——`view.order` 为稳定拓扑序（入度 0 队列按升序）。
- `select`：`{ok, instance}`——`instance` 形状 `{node, contract, chosen_instance, chosen_agent, candidates}`；无候选为 null。
- `hash`：`{hash}`——`hex(sha256(utf8(canonicalJson(value))))`。

## 边界

- 不做：图执行 / 解释器推进（归 `loop-policy`）/ 图模型读取的展示面（归各消费方）/ 命题审批与落账。
- 不读投影、无写通道、不发 eff；不取时间 / 随机，同输入同输出。
- 服务不 import 宿主与内核，运行时零依赖；跨身份只走 `port.call`。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
