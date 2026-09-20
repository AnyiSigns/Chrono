# #33 `loop-policy`（策略 / 图解释器 —— 唯一的编排插件）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 33 / `loop-policy` |
| 职责 | **唯一的编排插件**：回合管道 + **图解释器**（推式条件边 + 回合重入）+ 审批往返 + 回合尾触发。图与策略住**本身份的数据世代** |
| 依赖 | `->` 11–13、19、22（`recall` 节点）、23（回合尾维护）、27、32、34、**44 `evolve-metrics`**（pins）；`->` **全部节点能力类**（pins 即节点类型空间）；`+` 35 / 36 / 41 / **43** / **47** / **48**（**均由 #14 入口 term 读投影后随 bag 传入**：人格名 / 技能 / `workspace_id` / 证据台账 / 待办清单 / 提问游标；**服务不读投影**）；`<-` 14（版本提升：替换其管道，入口 term eff `loop-policy.interpret`）、17（S13 投影读本身份图与阈值） |
| 成员 | execute, terms, schema（**服务自驱解释器**：图执行住 execute；`pre`/`post`/`when`/边判定为服务内声明式规则） |
| 能力类·方法 | `implements: ["loop-policy"]`，`methods: {"loop-policy":["interpret"]}` |
| 命令 | 无（命令面仍归 14；#14 入口 term eff `loop-policy.interpret`） |
| schema | `schema/graph.json`（六类条目形状；**数据住数据世代，不在包树里**） |
| 机制 | 见下；完整设计见 `docs/plans/agent-graph-design.md` |
| 边界 | 不做节点实现（节点是各插件的 eff，经反向调用 `port.call` 派发）/ 不做审批判定（归 26）与审批流程（归 32）/ 不直接写链 / 不做模型端点选择与降级链（归 34）/ **不做池子组装拓扑**（见「演化口径」）/ **不做多图共存与选图**（单图） |
| 验收 | 见下「验收」 |
| 状态 | 细节设计（2026-09-19）：**Scope 统一**（节点=agent=作用域）、**推式条件边**（取代 `{from,on,to}`）、**单图演化**（取代多图+trigger）、回合重入、拒绝短路、scope 过滤、links 白名单；**2026-09-19 定案：解释器由 execute 服务自驱**（不再用宿主 run loop 递归执行图；判定改一次要换代，图/阈值数据仍住数据世代、可热改可回滚） |

> **本轮作废的两条旧口径**：① `edges:[{from, on:<判定值>, to}]`（状态机边，无 typed 端口 ⇒ `pre`/`post` 无落点 ⇒ dense 信号无来源 ⇒ 进化环断）；② 「拉式惰性 / `any` 端口先选边再求值前驱」（照搬实验，但实验的路由是可训模型；产品最核心的决定「模型这次要不要调工具」必须看实际产出才知道）。

---

## 0. 执行形态（2026-09-19 定案：服务自驱解释器）

> 本节覆盖文中一切「term 解释器 / 宿主 run loop 递归 / `{identity,path}` run 首解析」的旧表述。

- **入口**：#14 `chat` 的入口 term 发 `eff(loop-policy.interpret, bag)` 启动/恢复一次解释；#14 的 `pins` 新增 `loop-policy`。
- **解释器住 execute**：图遍历、边 `when`、契约 `pre`/`post`、拒绝短路、scope 过滤、实例选择、不变量与演化规则校验**全部是 #33 服务代码**（不再写成 term、不再经宿主 plan 通道递归）。
- **节点派发 = 反向调用**：`interpret` 内按 `pins` 对节点能力类发 `port.call`（`protocol.md` §2.4；发出者 = #33 身份），owner = #33，故节点 eff 按 #33 的 `pins` 路由。
- **数据仍住数据世代**：`contracts` / `nodes` / `prompts` / `graph` / `thresholds` / `refusal_codes` 六类条目仍是世界数据（可热改、可回滚）；**服务不读投影**，`interpret` 的图数据由 **#14 入口 term 读 `ctx` 后随 bag 传入**（`+ 35/36/41/43/47` 同理）。**改判定代码 = 换 execute = 换代**（这是本定案的代价，已接受）。
- **不再需要** `entry` / `pre` / `post` / `when` 的 `{identity,path}` 逻辑名与「run 首解析」；它们改为服务内按 `contract_id` / 声明式规则名解析（规则本体住数据世代，求值器住 execute）。
- **写链**：`interpret` 返回计划值，由 #14 入口 term 作为顶层 `$directives` 交宿主落账（服务无写通道不变）；`tool.dispatch` 阶段收集的工具写计划按 D3 冒泡并入。

---

## 一、核心概念统一：节点 = agent = 作用域

```
Scope = 节点 = agent = 一个可寻址的执行单元
```

| 组成 | 是什么 | 住哪 |
| --- | --- | --- |
| **契约** | 能力边界：inputs/outputs/reads/publishes/effects/pre/post | 本身份 `contracts` 条目 |
| **人格** | 是谁：system_prompt / model / decoding / 偏好工具 | `#35` instance 条目（被 `bindings.agent` pin） |
| **实现** | `atomic`（一次 eff）或 `composite`（内含子图） | 本身份 `nodes` 条目的 `impl` |
| **边界** | 读可见性 + 写面 + 权限 | 契约声明 + 解释器强制 |

四个原本分立的概念是同一个东西的不同粒度：**子代理** = Scope（atomic + 人格）；**协作者** = 多个同层 Scope 读同一份 `shared`；**子图** = Scope（composite）；**工作流** = 顶层 Scope 的子图（**不是"另一张图"**）。

⇒ **选图机制不存在**（早期设计的 `graphs` tail + `trigger` + 选图 term 整体作废）；`composite` 从结晶特例变成通则，手工加工作流与自动折叠子图**同形**。

---

## 二、六类条目（各自成 def + 链式 tail）

```
ids["loop-policy"].body = {
  contracts:     {tail,count},   // 能力类（闭集 append-only）
  nodes:         {tail,count},   // Scope 实例（开集，含 composite）
  prompts:       {tail,count},   // 提示词（各自成 def；含保留 id `system` = 图级系统提示词）
  graph:         {def:hash},     // **唯一顶层图**（单值，不是 tail）
  thresholds:    {tail,count},   // 阈值（热改）
  refusal_codes: {tail,count},   // 全局拒绝码表（append-only）
}
```

- 不能塞进一个 body：契约闭集、Scope 开集、提示词各自独立、阈值要热改；全塞一个 ⇒ 改一个提示词重写全量 ⇒ O(N²) 写放大。用 #11/#21/#35 同一招（条目成 def + `prev` 成链 + 宿主投影引用闭包解析进 `refs`）。
- **`graph` 是单值不是 tail**：单图口径 ⇒ 顶层只有一张；历史版本由**数据世代**承载（`add_gen` 追加、`set_active` 回滚）⇒ 回滚一次图变更 = 一条记账动作。
- **`prompts` 是第六类（本轮补）**：`bindings.prompt` 与图级系统提示词都按哈希引用 `prompts` 里的 def；此前只写了「提示词各自独立」却没给条目类型，是缺口。

### 系统提示词（`prompts` 保留 id `system`，本轮定）

- **归属 = 本插件（图类插件）**：它是图/策略数据的一部分，住 `prompts` 的保留 id `system`；改它 = 数据世代（热生效、可回滚），也可经 #45 `orchestration-admin` 提案 + 审批。
- **内容 = 行为准则 + 产品事实**（+ 可选输出风格）：
  - **行为准则**：怎么做事、何时停、何时问、失败怎么收口（只谈行为）。
  - **产品事实**：这是什么产品、能力边界、硬约束（只谈事实）。
- **两条红线（写死）**：
  1. **禁写工具标识符**：工具名 / 插件名 / 能力类名 / 端口名一律不出现。
  2. **只谈意图**：不写具体调用步骤、不写参数、不写实现细节。
- **为什么**：工具的语义住在 #27 契约的**描述四要素**里（`intent` / `when_to_use` / `param_semantics` / `boundaries`）；提示词写死工具名 ⇒ ① 换工具集就击穿提示词；② 击穿 prompt 前缀缓存（系统提示词是 #13 的 P0 稳定前缀，必须逐字节稳定）；③ 诱发模型按名字硬选而不是按意图选。
- **传递（解耦）**：`context.assemble` 节点把系统提示词写进 bag（`bag.system_prompt`），#13 作 P0 用；**#13 不读本插件的 schema**（否则 #13 就认识了图）。
- **`bindings.prompt`**：节点级提示词同样住 `prompts`（按哈希引用，不内联，见 §Scope 实例）。

### 契约

```
Contract = { contract_id, role_tag,
  inputs:  [{name, type, role?, required, cardinality:1|n, binding_mode:all|any}],
  outputs: [{name, type, role?, cardinality:1|n}],
  reads: [{key:SharedRef, optional?}], publishes: [SharedRef],
  pre: "<规则名>", post: "<规则名>",               // 服务内声明式规则引用（规则体住数据世代）
  refuses: [RefusalCode],                          // 只能引用全局码表
  effects: {ports, methods, caps},                 // = 权限上限，未声明即不注入
  idempotent, touches_effects, can_delegate,
  cost: {tokens?, calls?, tool_calls?, walltime?}, // 先验，不是计费真源
}
```

- **契约不可变**：改 `inputs`/`outputs`/`pre`/`post` 的判定式结构 = 新 `contract_id`。
- **阈值热改**：`post` 里的阈值不内联，按 `thresholds.<name>` 从**随 bag 传入的图数据**读 ⇒ 改阈值热生效、不动判定代码；改判定式 = 换 execute 代码 = 换代（服务自驱的既定代价）。**不需要**实验的 `put(slot=threshold)` + 结构指纹校验。
- **`post` 输入面**（否则不可复算）：只能引用本 Scope 的 `outputs`/`inputs`/`reads` 解析到的产物、`thresholds.*`、本步 `EffectAudit` 声明字段。不得引用其它 Scope 的 slot、全局统计、预算余量。
- **两级验收不混**：Scope 级 = `post`；回合级 = sink 产出 → `session.commit`。

### Scope 实例

```
Scope = { node_id, contract_id, impl:'atomic'|'composite',
  entry?:    {cap, method},           // atomic：派发目标（能力类 + 方法，按本插件 pins 路由）
  subgraph?: {nodes, edges, sink},    // composite：内部子图（同一图文法，递归）
  bindings: { agent?, prompt?, model?, decoding?, tools?, context_policy?, retry_policy? },
  autonomy: L0|L1,
  scope: { kind:'global'|'workspace'|'session', workspace_id?, session_id? },
  links?: [<contract_id>…],           // 互联白名单
}
```

- **`bindings` 必须 pin 不内联**（规矩 A）：内联提示词 ⇒ 改一个词就换 `H(Scope)` ⇒ 池里多一个节点 ⇒ 提示词 A/B 与漂移归因当场做不了。
- **节点派发目标 = 能力类 + 方法**（按本插件 `pins` 路由，经反向调用 `port.call`）；不再用 `{identity,path}` 逻辑名 / 「run 首解析」。写期校验：`effects.ports` ⊆ 本插件 `pins`，否则拒绝写入。
- **节点类型空间 = 本插件 `pins`**：扩节点类型 = 一次换代（显式记账、可回滚）。
- **同契约多实例选择**（必须写死，否则不可复现）：图里只写 `contract_id`；运行时先按 `scope` 过滤候选集，再按字典序 `(隔离升序, 成功率下界降序, cost 升序, node_id 升序)` 取首，记 `chosen_instance` / `chosen_agent`。A/B 必须强制指定实例。

### 拒绝码（全局 append-only，聚类唯一来源）

`pre_unsat`(node) / `input_insufficient`(graph,可重试) / `capability_mismatch`(**graph**——编排选错了 Scope) / `budget`(budget) / `undeclared_read`(node) / `downstream_refusal`(graph) / `redundant`(graph) / `transport_failed`(node,可重试) / `stale_dep`(graph) / `scope_mismatch`(graph) / `link_denied`(graph) / `needs_approval`(**user**) / `denied`(**user**)。

- **`attributable_to` 必须有 `user` 维**（产品特有）：用户拒批 20 次是**偏好**不是能力缺口；少这维会把审批拒绝误诊成能力缺口并触发无谓提案。
- `='graph'` ⇒ 改提示词/改接线；只有 `='node'` 且**跨多契约重复**才是新能力的证据。
- **`no_progress` 不在此表**：它是**证据类型**不是运行时拒绝码（见「自治」）。

---

## 三、图与六条不变量

```
Graph = { nodes:[contract_id…],                          // 生成序，下标 = node_index
  edges:[{from:[u,out], to:[v,in], when?:"<规则名>"}],
  entry_supply:[{type_id, role?}],
  loop:{ when:"<规则名>", max_iter:<thresholds 名> },
          sink:<node_index>, derived_from?:<旧图 def 哈希> }
```

**闭合**：required 入边全连 ∧ 非首节点 ≥1 入边 ∧ 每节点有向路径到 sink ∧ `|V|≥1` ∧ 无环。**sink 唯一**（多终产物用 `cardinality:'n'` 汇聚；多个无出边节点并列充当终点不允许——否则收口面不唯一）。

**类型系统** = nominal + `type_id`（append-only 表，带 `subtypes`）；端口带 `role`（`code`/`plan`/`critique`/…）把"唯一匹配自动补齐"从稀有变常态；歧义时必须写显式端口对。

**六条不变量（机械闸校验）**：

1. **兜底首节点**：池中始终保留一个只依赖 `entry_supply` 的 `touches_effects:false` 契约。
2. **`join` 契约必在**：跨互斥分支的 shared 合并必须有合法手段。
3. **`subagent` 契约必在**：保证"加子代理不必改图"。
4. **审批段不可绕过**：声明高危端口（`fs` 写 / `exec` / `plugin.write` / `orchestration.propose`；**实际判据 = (port=提供者能力类名, 工具名)**，2026-09-19 与 #26/#27 对齐）的 Scope，其可达路径上必须存在 `guard → approval` 段，否则**写期拒**。理由：#25 仍钳制四档 fs 范围，删审批拿不到范围外权限；但"升级弹卡"这一档**只能由图表达** ⇒ 图能删它等于静默降档。**对 composite 同样生效**。
5. **`llm_chain_max`**：任一路径上连续 LLM Scope 数 ≤ `thresholds.llm_chain_max`（默认 2）。**判据 = 契约 `effects.ports` 含 `model`**（不引入实验的 `implementation` 字段）。理由：连续三次 LLM 无中间产物被 `post` 拦、每个 LLM Scope 一次真实调用永不 memo ⇒ 成本线性叠加。composite 按子图最长连续 LLM 链折算。
6. **`last_global_instance`**：任一契约必须至少有一个 `scope:global` 实例。

---

## 四、控制流：推式条件边 + 拒绝短路

- `when` 是**服务内声明式规则引用**（与 `pre`/`post` 同形），入参 = 上游产出 + 状态摘要；缺省 = 无条件。种子判定（`nonempty` / `eq` / `verdict_is`）由 #33 服务内置求值器解释。
- 执行：从首节点前推，每步按**已求值**的产出算 `when`，只沿成立的边走。未走分支 0 计费、记 `branch_not_taken`。
- `binding_mode`：`all` = 所有入边都会触发（AND 汇聚）；**`any` = 恰有一条入边会触发**（互斥分支汇合），`cardinality=1`。这是控制流的**结果**，不是路由决策。
- **"多路都跑再挑"必须显式建模**为 `cardinality:'n'` 的 `all` 端口 + 聚合契约（`vote`/`judge`/`merge`），N 路全计费。与 `any` 语义不同、不可互相顶替。
- **可重放**：活动路径由 `(拓扑, 各 Scope 实际产出)` 唯一决定；LLM 产出不确定，但**审计回灌下逐字节等价**。
- **DAG 保留**：无环买到单写者 slot 键唯一 + publish 偏序可静态判 + 一条路径上任一节点至多执行一次。终止性已由 `MAX_STEPS`+`gas` 保证，放开环换不到东西。

**拒绝短路到 sink（写死）**：Scope 拒绝 ⇒ 解释器直接跳 sink 带码收口，**不为每个 Scope 画拒绝出边**。sink 落一条带错误的消息（#11 既有 `system` + `meta.error` 形状），回合正常结束、不是 run 失败；未求值 Scope 记 `branch_not_taken`；**`trace` 必须记 `refused_at`**（`node_index`/`iter`/码/归因）。

> 这是对"数据流完全由拓扑决定"的**一处明确让步**（不掩饰）：拒绝跳转是解释器隐式控制流、图里不可见。接受理由：拒绝处理逻辑统一（收口+落码+记轨迹），不值得在图里重复 N 次——种子图 7 节点已有 11 边，每节点再接拒绝边会到 18 边而做的是同一件事。让步边界清楚：**只有拒绝短路隐式，正常产物流向 100% 由边决定**。
> 「拒绝后想走别的路」不是拒绝而是**互联**：Scope 产"请求跳转"而非"我做不了"，走 `links`。拒绝 = 这条路走不通；互联 = 换条路继续。

---

## 五、分段执行（服务内循环，不再用宿主 run loop 递归）

`kernel.md` §十二 的单 pending / 不捕获续体只约束**宿主 run**；图执行住 #33 服务进程，不受「一个 directive 内 k 个效果 ⇒ O(k²)」约束——服务在一次 `interpret` 内顺序推进多个节点。

```
interpret(bag)：
  loop:
    读当前图数据（contracts / nodes / prompts / graph / thresholds / refusal_codes）
    解析当前 Scope（contract_id → 按 scope 过滤选实例）
    求值 pre（服务内规则）→ 不过 ⇒ 带码拒绝
    经 port.call 派发节点能力类（发出者 = #33，按本插件 pins 路由）→ 收结果
    求值 post（服务内规则）→ 不过 ⇒ 带码拒绝
    按 when（服务内规则）定下一 Scope；到 sink 收口
  返回计划值（session 写 + trace 写）交 #14 入口 term 作顶层 $directives
```

- **游标不进世界**：一次 `interpret` 内的 `iter` / `cursor` / `slots` / `shared` 是服务进程内状态，不落账；只有**回合尾一次写**（消息 + trace + 队列项）落世界。
- **产物两档**：小产物在服务内存传递；大产物段尾 `write` 成 def、后续按哈希经 `refs` 引用（阈值住 `thresholds`）。
- **审批 / 提问往返**：`interpret` 在入队 / 提问处**正常返回**（本 run 正常结束），resume 游标随队列项落世界；裁决 / 作答落账后宿主按游标触发**新 run** → #14 入口 term 再次 eff `loop-policy.interpret` 恢复。
- **节点扇出（v1 保守）**：经 `port.call`（同一服务可挂多个在途反向调用）顺序跑完 N 路 + 聚合；**run 之间**并发由 threads-design §二 承载（宿主 run 级并发 + 提交队列 + 乐观校验）。
- **代价（明写）**：判定代码住 execute ⇒ 改 `pre` / `post` / `when` 要换代；图 / 阈值数据仍住数据世代、热改可回滚。

---

## 六、回合重入（DAG 怎么表达工具循环）

工具循环天然是环，而图是 DAG。三条候选里两条不行：**放开环**破三条不变量且换不到东西；**塞进 L1 内部**会让工具派发与审批不再是图节点 ⇒ 不变量 4 无从校验、工具结果拿不到 `post` ⇒ dense 信号丢一半。

**采纳：回合 = 多次图执行。** 图描述**一次模型轮次**；本轮派发过工具 ⇒ 按 `Graph.loop` 重入，`iter+1`。服务内以 `iter` 循环表达；每轮消息落 #11 ⇒ 下一轮 `context.assemble` 自然看到工具结果。

四条好处（不是将就）：图是 DAG 且小；审批段是真节点、不变量可校验；每次重入**全新 slots** ⇒ 单写者平凡成立；每轮消息落 #11 ⇒ 下一轮 `context.assemble` 自然看到工具结果。

达 `max_turn_iter` 仍在派发 ⇒ 落 `budget` 拒绝码并收口（**不静默截断**）。

---

## 七、种子图（包内，兜底目标）

> **加强口径（2026-09-19）**：早期版本的种子图只有六节点、零 `post`、不用任何池不变量要求的契约。
> 那有一个**自举漏洞**：`agent.step` 是铁块 ⇒ 失败全归一个契约 ⇒ 指标层没有可归因粒度 ⇒ **进化环冷启动不了**。
> 「没有证据支持哪种拆法」这条理由对**怎么拆**成立，对**一点结构都不给**不成立。
> 本轮加强三处，**都不碰默认路径**（验收 1 的逐字节等价仍成立）。

### 7.1 种子契约（十一个）

| contract_id | eff 到 | touches_effects | 用在种子图 | 说明 |
| --- | --- | --- | --- | --- |
| `recall` | `retrieval.search`（#22） | true | ✗ | 召回先于组装；**种子图 v1 刻意暂不插 recall 节点**（非因 #22 未建——#22 W3 早于 #33 W6）⇒ 契约声明、节点待插（版本提升） |
| `context.assemble` | `context.build`（#13） | false | ✓ 0 | 产 messages + 请求参数；把**系统提示词**（`prompts.system`）写进 bag 交 #13 作 P0 |
| `agent.step` | `model.chat`（#12） | true | ✓ 1 | 产 assistant message **或** tool_calls；`determinism:audited`、`idempotent:false`、永不 memo |
| `tool.gate` | `guard.judge`（#26） | false | ✓ 2 | 纯函数；**按 call 逐项判**（整批），产每项 verdict + 批级汇总：`allow` / `escalate` / `deny` |
| `approval.wait` | `approval.enqueue`（#32） | false | ✓ 3 | 入队后本 run 正常结束，靠 resume 游标续跑 |
| `tool.dispatch` | `tools.dispatch`（#27） | true | ✓ 4 | **整批 `calls[]` 一次 eff**；并发在 #27 进程内（见 #27「整批 + 并发」）；高危；受不变量 4 约束 |
| **`verify`** | `tools.dispatch`（#27，工具名 `shell` → #29 执行） | true | ✓ 5 | **本轮新增**：跑工作区声明的校验命令（`bindings.tools` 里的命令串经 `#27 shell` 工具执行，即 #29 沙箱内跑命令——不再含糊「dispatch 什么」）；默认实例是 no-op（见 7.4） |
| **`join`** | 无（纯函数） | false | ✗ | **不变量 2 要求必在**：跨互斥分支的 shared 版本合并 |
| **`subagent`** | `model.chat`（#12） | true | ✗ | **不变量 3 要求必在**：`bindings.agent` 由上游 slot 解析 ⇒ 加子代理不必改图 |
| **`evolve.propose`** | `model.chat`（#12） | true | ✗ | **v1 闭环新增（2026-09-19）**：LLM 提案 Scope，**不在种子图边里**（非默认路径）；回合尾 #44 产证据达阈 ⇒ #33 触发此 Scope 产提案写 #43 `proposals`；受 `llm_chain_max` 约束（独立触发、不与 `agent.step` 串链）；**用户请求也是证据**（先落 `class:'user_request'` 证据再触发此 Scope，见 §十三） |
| `turn.commit` | `session.commit`（#11） | false | ✓ 6 | **sink**；返回计划 `{$directives:[write(batch), …]}` |

**`join` / `subagent` 声明但不接线**：契约是**词汇**，图不必用到每个词。
但不变量 6（`last_global_instance`）要求每个契约至少有一个 `scope:global` 实例，
故各配一个中性全局实例（`join` 取"同键取最新"的确定性合并；`subagent` 用中性提示词）。
⇒ **不变量 2 / 3 / 6 从第一天就可满足**，不是"以后会满足"。

### 7.2 种子图

```
nodes: [ assemble(0), step(1), gate(2), approval.wait(3), dispatch(4), verify(5), commit(6) ]
edges:
  0:messages   → 1:messages                              (无条件)
  1:tool_calls → 2:calls         when nonempty(tool_calls)
  1:message    → 6:message       when empty(tool_calls)
  2:verdict    → 4:verdict       when verdict_is(allow)
  2:verdict    → 3:request       when verdict_is(escalate)
  2:verdict    → 6:refusal       when verdict_is(deny)
  3:decision   → 4:verdict       when verdict_is(approved)
  3:decision   → 6:refusal       when verdict_is(denied)
  4:results    → 5:changes       when wrote_files(results)      ← 本轮新增分支
  4:results    → 6:results       when not wrote_files(results)
  5:report     → 6:report                                (无条件)
loop: { when: dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete, max_iter: thresholds.max_turn_iter }
sink: 6
```

- 节点 6（`turn.commit`）入端口 `binding_mode:any` / `cardinality:1`——**五条入边互斥**，恰一条触发。
- **种子判定**（包内附，`when` 引用）：`nonempty` / `empty` / `eq` / `verdict_is` / **`wrote_files`**（本轮新增，
  机械查 results 里有无写类工具成功项）/ **`todo_incomplete`**（本轮新增，#47：当前会话待办清单存在 `pending` / `in_progress` 项 ⇒ 不收口、继续 loop；防"幻觉式收尾"）/ **`question_pending`**（2026-09-19 新增，#48：本轮 `tool.dispatch` 派发过 `question` 工具且未作答 ⇒ **不 loop、本 run 正常结束**，作答后宿主按 resume 游标触发新 run 回灌答案，与 `approval.wait` 同源跨 run 机制）。

- **整批工具调用与并发（本轮定）**：`tool.gate` / `tool.dispatch` 都按**整批**处理——`tool.dispatch` 把 `calls[]` 一次交给 #27，**并发在 #27 进程内**（对内核仍是一个 eff，见 #27「整批 + 并发」）。
  - **v1 批级汇总取最严**：批内 `any deny` → `deny`（整批不执行）；否则 `any escalate` → `escalate`（整批走 `approval.wait`）；否则 `allow`（整批并发执行）。**图不拆批、边不变、不变量 4 可机械校验。**
  - **登记（后续细化，本轮不改图）**：按 call 逐项拆批——`allowed` 立刻并发执行、`escalated` 入队、批准后只补跑该项——需把 `tool.gate` 输出从单 verdict 改成 `allowed` / `escalated` / `denied` 三路并调边。收益：一项要审批不拖累其余项；代价：种子图边数与 `when` 判定增加。

**无工具路径（默认路径，必须与 #14 原管道逐字节等价）**：

```
iter1: assemble → step(模型直接答) → commit        // = context.build → model.chat → session.commit ✓
loop.when 为假 ⇒ 收口
```

⇒ **加强完全没有落在这条路径上**：简单问答仍是三步、零额外模型调用、零额外成本。

**有工具路径（等价于既定 `26→27→32→39→33`，尾部多一个条件校验）**：

```
iter1: assemble → step(产 tool_calls) → gate
         ├ allow    → dispatch ─┬ wrote_files → verify → commit
         │                      └ 未写文件      → commit
         ├ escalate → approval.wait（入队）⇒ 本 run 正常结束
         │              #39 裁决落账 → 按 resume 游标触发新 run
         │              ├ approved → dispatch → …（同上）
         │              └ denied   → commit（落拒绝）
         └ deny     → commit（落拒绝，不执行）
loop.when 为真（派发过工具 或 verify 失败）⇒ iter2
iter2: assemble（含工具结果 + verify 报告）→ step → commit
```

达 `max_turn_iter` 仍在派发 ⇒ 落 `budget` 拒绝码并收口（**不静默截断**）。

### 7.3 机械 `post`（零 token、零新节点，本轮新增）

这是**收益最高、代价为零**的一处加强：不加节点、不加调用，只把"本来在下游才炸"的检查提前成 Scope 级判定，
于是它同时成为 **dense 信号源**（原设计 `post` 是唯一 dense 来源，但种子图没有一个实质 `post`）。

| Scope | `post` 检查什么 | 挡住什么 | 输入面合规 |
| --- | --- | --- | --- |
| `context.assemble` | messages 非空、末条为 user/tool、请求参数含 model | 组装出空上下文就调模型 | 本节点 outputs |
| **`agent.step`** | 产出**非空** ∧ （message 或 tool_calls 恰有其一）∧ tool_calls **结构合法**（name 非空串、args 是对象、call_id 不重复） | **模型吐畸形 tool_call**（原本要到 #27 才失败，且归因指向 #27 而非模型） | 本节点 outputs |
| `tool.dispatch` | results 条数 == calls 条数 ∧ 每项有 `ok`/`error` ∧ 失败项带码 | 部分结果丢失被当成全成功 | 本节点 outputs + inputs |
| **`verify`** | report 形状合法（`skipped` 或 `passed`+`detail`） | 校验器自身坏了被读成"通过" | 本节点 outputs + 本步 `EffectAudit` 的 `exit_code` |

**只做结构检查，不查语义**：`post` 的输入面被写死为"本 Scope 的 outputs / inputs / reads + `thresholds.*` +
本步 `EffectAudit` 声明字段"，**读不到工具目录** ⇒ 只能查 `name` 是**非空字符串**，不能查"这个工具是否存在"
（后者在 #27 派发时查，本来就在那儿）。这条边界是刻意的：放宽 `post` 输入面会让 dense 标签依赖全局状态、不可复算。

### 7.4 `verify` 的 scope 分档（用上刚设计的机制）

`verify` 一个契约、两类实例，**靠 `scope` 过滤自动选中**：

| 实例 | `scope` | `bindings` | 行为 |
| --- | --- | --- | --- |
| `vf-noop` | `global` | 无 | 返回 `{skipped:true}`，**不发 eff、零成本** |
| `vf-<ws>` | `workspace`（该工作区） | `tools` 绑定校验命令（如 `cargo test` / `npm test`） | eff #27 `tools.dispatch`（工具名 `shell` → #29 沙箱内执行），产 `{passed, detail, exit_code}` |

- **默认零成本**：只有 `vf-noop` 时 `verify` 节点是一次纯计算，不调工具、不花 token。
  用户给某工作区配了校验命令才产生真实执行 ⇒ **加强不向未配置的用户收费**。
- **这是 `scope` 机制的第一个真实用例**：结构通用（图里只有 `contract_id = verify`）、
  专门化落实例（每个项目自己的校验命令）——正是「图通用、专门化落实例层」口径的兑现。
- **安全性**：校验命令来自 `bindings`（pin 住的数据、由人或提案设定），**不是模型输出**
  ⇒ 与"模型自选命令"风险档次不同。不变量 4 的判据是「声明高危端口的 Scope，其高危调用在 `tool.gate` 后必经 `approval.wait`」——种子图里 `gate` 的 `escalate` 边即该段（`allow` 边只承载低危调用），故**结构上满足**。
- **不阻断收口**（判断题，明写选择）：`verify` 失败**不拒绝、不丢工作**，只把报告带进 `commit`，
  由 `loop.when` 触发下一 iter 让模型看着失败详情自己修。
  理由：阻断会让已写入的文件变更失去落账机会；而重入本来就是"再来一轮"的既定机制（§6）。
- **顺带解决一件事**：§11.2 提过"有测试的工作区可加第四道门禁（跑真测试判分）"，
  `verify` 的 `passed` 就是那道门禁的**数据来源**——它是产品域**最接近 oracle** 的信号。

### 7.5 本轮明确**不加**的三样（附理由）

| 不加 | 为什么 |
| --- | --- |
| `plan` / `critique` / `repair` 预拆 | 这才是**该由证据驱动**的部分。预先拆 = 凭感觉写死，且每个 LLM Scope 一次真实调用永不 memo ⇒ 简单问答成本翻倍。等 `failure_cluster` / `no_progress` 证据指向再拆（提案方向已在 #44 标注） |
| 把 `gate + approval` 折成 composite | 会把审批段藏进子图。不变量 4 虽对 composite 同样生效，但**保持审批段在顶层可见**让人读图时一眼看到"这里会弹卡"，这个可读性不值得换 |
| 任何落在**默认路径**上的节点 | 验收 1 要求与 #14 原管道逐字节等价；且默认路径是最高频路径，加什么都是全局成本 |

**加强后种子图仍是"下限不是目标"**：它现在有了可归因的粒度（四个实质 `post`）、
一个近 oracle 信号（`verify`）、完整的池词汇（`join` / `subagent`），
但**流程结构仍然扁平**——怎么拆 `agent.step` 依然留给证据决定。

**审批段的准确时序（纠一处易错表述）**：内核 `waiting` 是**效果未回灌**时的状态，而 `approval.enqueue` **会正常返回**（入队成功）⇒ 那一轮不是 `waiting`。正确形状：① `approval.wait` 发 eff → 正常返回"已入队"；② `interpret` 在入队处**正常返回**（产 `write` 落队列项、**含 resume 游标** + `extern` 回执）⇒ **本 run 正常结束**；③ 人在 #39 裁决 → `approval.decide` 计划落账；④ 宿主据游标触发**新 run** → #14 入口 term 再次 eff `loop-policy.interpret` 恢复继续。⇒ 与 #32 既定「**跨 run** 挂起/续跑」一致。游标能跨 run 是因为它被写进队列项（跨 run 必须落世界）。

**种子图是下限不是目标**：它故意扁平（只有"要不要调工具"一个判断），承担两件事——与 #14 逐字节等价、坏图时的回落目标。**进化方向 = 把隐式的显式化**：例如证据显示改代码类任务反复失败，提案会把 `agent.step` 变成 composite Scope，内含 `plan → code → critique → repair`，每个子 Scope 有自己的 prompt pin、自己的 post、自己的成功率统计。种子图不预先长这样——没有证据支持哪种拆法更好，预先拆 = 凭感觉写死。

---

## 八、状态通信与隔离

```
GraphState = { task,
  shared: Record<SharedRef, Artifact[]>,                   // 只读协作面，同键版本 append-only
  slots:  Record<(node_index,out_port,iter), Artifact>,    // 单写者点对点槽
  budget:{remaining,spent}, iter, cursor }
```

| 通道 | 谁能写 | 谁能读 | 活多久 | 落账 |
| --- | --- | --- | --- | --- |
| **slots** | 该槽唯一生产者 | 仅入边指向它的 Scope | 一次图执行（重入即清空） | 否 |
| **shared** | 只有运行时（初始化 / 显式 `publish`） | 声明了 `reads` 的 Scope | 一个 run（跨 iter、跨续跑） | 否 |
| **世界数据身份** | 计划通道落账（#11/#3/#21/#35） | 任何读投影的 term | 永久 | 是 |

三条推论：① **跨回合通信必须落世界**（slots/shared 住 eval args，run 结束即没）；② **跨 iter 的消息走 #11 不走 shared**（#11 是展示真源，另存一份 ⇒ 两份真源）⇒ shared 只装本 run 内派生的协作材料；③ 续跑安全（游标在 args ⇒ 重放到同一 eff 取 `results[id]`）。

**同键发布偏序铁律**：同一 `SharedRef` 的所有发布 Scope 两两必须有拓扑偏序（写期静态检查），否则"状态是执行的纯函数"不成立。读键 K 看到的是**拓扑上先于它、已求值、偏序最后**的版本；该发布者落在未触发分支上则跳过取前一个。**由 (拓扑, 实际产出) 唯一决定**。互斥分支例外需收在显式 `join`；互斥判据**充分不必要**（判不出即视为可同时命中 ⇒ 保守拒，宁可拒掉一部分实际安全的图）。

**三处标识分开**：`node_index`（图内生成序）/ `node_id`（Scope 实例，不进图）/ `contract_id`（能力类）。slot 键与 producer 用 `(node_index, iter)`。

**五层隔离与强制点**（强制点决定挡得住什么）：读可见性 / 写面 / 专门化 / 权限 四层**强制点在解释器服务，不在宿主**——宿主不认识图与契约，只保证 `caps` 恒等于输入 + `pins` 解析，且 `host.md` 明写 **v1 无 op 级鉴权**。⇒ **图层隔离防"写错"不防"恶意"**；真正的硬隔离只有 `caps` 不扩权（内核）+ 进程隔离（宿主）+ #25 沙箱 fs 钳制。这也是不变量 4 与「回滚入口在图外」存在的另一个理由。

**composite 嵌套规则**（写期校验）：子图 slot 不泄漏到外层；`reads` 只能收窄（⊆ 父契约）；父契约 `effects` 必须 ⊇ 子图并集（**不能靠嵌套扩权**）；`scope` 只能收窄（global 父可含 workspace 子，反之拒）；Scope 不持有跨调用状态（⇒ 子代理没有私有持久记忆，要记就落 #21 带 tag + scope）。

---

## 九、作用域隔离：图通用，工作区信息隔离

**口径**：**图通用，不按工作区分叉**。切工作区/会话隔离的是**信息**不是**结构**。理由：结构分叉会让每工作区样本量除以 N ⇒ 证据攒不够 ⇒ 进化环空转；而工作区间真正不同的是**材料**（代码库、惯例、技术栈）不是**流程**。

**强制点在实例选择，不在边条件**（关键）：解释器按 `contract_id` 选实例时候选集**先按 `scope` 过滤**——`scope.kind='workspace'` 且 `workspace_id ≠ 当前会话的` ⇒ **不进候选集**。⇒ `when` 写错最多走错分支，**不会**让 B 工作区用上 A 的专属 agent。配不变量 6 兜底（删掉最后一个 global 实例 ⇒ 拒）。

⇒ 专门化落**实例层**不落**结构层**：结构共享（样本量不被除）+ 实例专属（材料不串味）。

---

## 十、自治与互联（路径走岔的两条出路）

推式条件边只能沿预设边走；模型产出落在没预料的形态上时路径会走岔。两条出路各有病症，先说病症再定约束。

**自治（病症：突然 end）** —— 只开 L0 / L1：

| 档 | 能做什么 | 约束 |
| --- | --- | --- |
| L0 | 纯函数：一次调用出结果 | 工具 Scope 默认 |
| L1 | 内部有界循环：自检 / 重试 / 换工具 / 请求追加输入 / 拒绝并给原因 | 迭代上限、预算上限、退出条件由 `bindings.retry_policy` **声明** |

四条约束堵"突然 end"：① **L1 不能自己决定"完成"**，出口只有过 `post` 的 outputs 或带码 refusal，**没有第三种"我不干了"** ⇒ 突然 end 在类型层面不存在；② **`post` 机械、不由 Scope 自己判**；③ 迭代上限住声明不住代码；④ **`no_progress` 是证据类型不是运行时拒绝码**——L1 迭代在 Scope 内部（一次 eff），解释器看不到内部迭代，让 Scope 自己判又破第 1 条 ⇒ 运行时**不拦**，`trace` 记迭代次数与打满标记，`evolve-metrics` 据此产 `no_progress` 证据（提案方向 = 拆该 Scope）。**代价**：那一轮钱照花；可接受——成本已由迭代上限封顶，损失有界，而要运行时拦就得让所有 L1 契约多一个必填输出位。

**三条自治不变量**：自治只能花预算**不能拿权限**；自治决策必须留痕；自治不改变可寻址面。`autonomy:L1` ⇒ `retry_policy` 必填。**L1 请求追加输入必须声明式**（只能取 `reads` 里 `optional:true` 的 shared 键，**不能触发新的前驱求值**，否则活动路径执行期变形）。

**L2 委派 / L3 自产拓扑不开**：L2 要跨 run 才能生成子图；L3 让"拓扑唯一来源"破功。**多层子代理靠 composite 嵌套表达**。

**互联（病症：跳到不相干节点）** —— `links` 白名单 + 声明式，不是自由跳转：

1. 目标必须在 `links` 里且白名单项在图里有对应 Scope（写期校验）；不在 ⇒ `link_denied`。⇒ 跳转集合**写期可枚举** ⇒ 路径空间有限、`sig` 仍可比。
2. **互联边进图、进 `sig`**：一条跳转在数据里就是一条 `edge`，`when` 引用"上游要求跳转"这个产出位。⇒ **不是绕过图的旁路**。
3. **不得破 DAG**："回到前面重做"只能靠重入（`iter+1`），不能靠互联边指回去。
4. **必须留痕**：记 `link_taken`（源 Scope / 目标契约 / 原因码）。

**代价**：白名单要维护；过宽 ⇒ 路径空间变大 ⇒ 样本量摊薄 ⇒ 归因变弱。故受 `thresholds.max_links` 限，**扩白名单属结构变更、走门禁**。

**两条出路分工（防重叠）**：同能力再试 → 自治；换能力 → 互联；重做整轮 → 重入。**不许用自治模拟互联**（契约 `effects` 没声明的端口运行时不注入，权限层已堵，但明写以防有人把多能力塞进 `retry_policy`）。

---

## 十一、演化口径：单图渐进演化，不做池子组装

**决策**：顶层只有一张图，靠 fork 后有限改动演化；**禁止从池子现场组装拓扑**。

**为什么不组装**：实验能组装是因为有任务级 oracle + 可训编排 + 搜索器，组装出的图好不好它能测出来。产品三样全没有 ⇒ **没有判优手段的组装 = 随机结构生成**。四个具体病症：成本爆炸（每 LLM Scope 一次真实调用永不 memo）/ 提示词漂移 / 归因崩塌（每张图样本量 ~1）/ 不可比（`sig` 每轮变，去重与漂移检测失去锚）。

**四条演化规则**（机械闸校验）：① **fork-only**（新图只能从当前 active fork 后改，写 `derived_from`，禁空白生成）；② **diff 上限** ≤ `thresholds.max_graph_diff`；③ **`min_runs_before_fork`**（攒够 N 回合才能作下次 fork 的基，否则噪声上叠噪声）；④ **`llm_chain_max ≤ 2`**（不变量 5）。

**池子是词汇表不是拼装原料**：`contracts` = 能力词汇（闭集）、`nodes` = 每个词汇的可选实现（开集）。演化方式是**替换与插入**，不是"抽 N 个词重新造句"。

**四类允许的结构变更**：绑定变异（不占额度）/ 实例生长（实例级额度）/ 结构改动（额度）/ 折叠（契约级额度）。

**折叠（结晶）是唯一使复杂度下降的方向**：同一子路径在 ≥k 个回合上**回合级成功**（不是 Scope 级 post 通过）⇒ 折成 composite Scope。用户手动"加一个工作流"走同一条路。合成不变量：`effects`/`publishes`/`refuses` 取**并集**；`pre` 取入口前置合取；`post` 取**所有活动路径都执行**的 Scope 的 post 合取（不得并入只在部分分支上的 post）；`idempotent` = 全确定才 true；`scope` 取**最窄**者；深度与 LLM 链按子图折算。**收益边界**：子图内部逐 Scope 照常计费 ⇒ 折叠降的是**外层可寻址复杂度**不降执行成本；若出现"折叠后成本下降"只可能来自路径变化，必须单独归因。

---

## 十二、坏图的出路（四道）

1. **写期前移**：机械闸在写入前拒（#45 服务的 `validate` dry-run 复刻同一套规则；入世 / `add_gen` 另有宿主 `pins` 层机械校验）。
2. **种子图兜底**：`graph` 为空 / 解析失败 ⇒ 回落**包内种子图**。单图口径下没有"选另一张图"，所以兜底必须是包内的、不能是世界里的另一条数据。
3. **运行期自限**：`MAX_STEPS` / `max_turn_iter` + `limits.gas` ⇒ 坏图**必定终止**（`refused`），不挂死。
4. **回滚入口在图外**：连续失败判定住 **#44 `evolve-metrics` 服务 + #17 的 term**（均独立于本插件）——#44 周期 `aggregate` 读 `evolution.trace` 投影产 `failure_cluster` 证据超 #33 阈值即发 `orchestration.unhealthy` 事件（#44 是纯统计、不跑本插件解释器，**故本插件图坏掉时仍能发**）；#17 出"编排健康 + 回滚到上一世代"（只读视图），#38 推通知；回滚 = 入站面直接提交 `set_active`（`host.md` 已允许发起者直接提交 directive）⇒ 零宿主改动、零新动词。

**为什么不放宿主 watchdog**：让宿主在连续失败时自己走本插件的 fallback = 宿主认识本插件业务，破「载体不认识业务」。判定必须住图外插件（#44 服务 + #17 term）、触发者必须在图外——两条同时满足的只有"图外插件 + 人按一下"。

---

## 十三、与审批、管道、进化环的关系

- **缺省即静态管道**：无 `graph` 数据时回落包内种子图，与 #14 原管道逐字节等价。
- **审批往返**：`26` 判升级 → `27` → `32` 入队 → 本 run 正常结束 → `39` 裁决 → 宿主按 resume 游标触发新 run → 本插件据终局继续或终止；**4 档 fs 强制归 #25**（不在此判定），批准后放行走 #25 的一次性 `caps.grant`。
- **回合尾**：按策略 eff `compress`（#19）等；记忆行为准则住本身份策略数据。压缩**不设专门图节点**——#13 按 75% 阈值追加 system 消息提示 agent，agent 经记忆工具调 #19/#23 落计划。
- **提问往返（#48，2026-09-19 闭合）**：模型经 `tool.dispatch` 调 `question` 工具 → #48 `invoke` 写队列项（含 `resume_cursor` + 问题）+ 返回「pending」标志（**不清槽**；清槽只归 `question.answer` 命令） → `tool.dispatch` 的 `post` 不过（非畸形）→ `question_pending` 为真 ⇒ `loop.when` 为假 ⇒ **不 loop、本 run 走 sink 正常结束**（落消息 + 队列项）；用户在 #18 卡作答 → `question.answer` 写计划记答案 + 清项 → 宿主按 `resume_cursor` 触发**新 run**，答案作为 `question` 工具结果回灌 `tool.dispatch` → 解释器据游标恢复继续。**与 `approval.wait` 同源**（跨 run resume，区别：审批 = allow/deny 门禁、question = 开放作答，见 #48）。**#1 input 需加 `question.answer` 槽 kind**（#48 版本提升）。
- **进化环（v1 闭合，2026-09-19）**：回合尾写 `evolution.trace`（含 `directives_summary`/`ctx_summary`，影子回放载体）→ eff `evolve-metrics.aggregate`（#44）产证据 → **#33 读新证据投影，若达阈则触发 `evolve.propose` Scope**（LLM，独立触发、不与 `agent.step` 串链，受 `llm_chain_max` 约束）产提案写 #43 `proposals`（**用户请求也是证据**：先落 `class:'user_request'` 证据再触发此 Scope，避免分签红线——#45 不产证据，但 `evolve.propose` 是图内 LLM Scope 不是 #45）→ 三道门禁（**机械闸** = #33 服务本地跑 `validate` 逻辑；**影子回放** = #44 `shadow` 方法纯计算，据新图 + #43 `directives_summary`/`ctx_summary` 重构等价 `directives`+`ctx`，按 `(port,method,canonicalJson(args))` 与历史 `EffectAudit` 配对回灌，缺匹配记 `shadow:"unverified"`；**人闸** = #32/#39 审批，`orchestration_change` kind）→ `verdicts` 落账（采纳与拒绝都写）→ 采纳 = 对自身数据世代 `add_gen`（新图）→ 回滚 = `set_active` → 下一代图 → 新 `trace`。**两层分签**：#44 只产证据（+ 影子回放指标，均纯计算）、#45 只产提案不产证据不产写；`evolve.propose` 是图内 LLM Scope（产提案，不产证据）。
- **等待审批期间不占用 #26**（26 是纯函数）。

---

## 验收

1. **回落等价**：`graph` 为空时与 #14 原管道**逐字节等价**；种子图无工具路径同样等价（**加强不落在默认路径上**：简单问答仍是 assemble→step→commit 三步、零额外调用）。
2. **审批往返等价**：种子图有工具路径与既定 `26→27→32→39→33` 时序一致，含**跨 run** 续跑（游标随队列项落世界）。
2b. **机械 `post` 生效**：模型吐畸形 tool_call（name 空串 / args 非对象 / call_id 重复）⇒ `agent.step` 的 `post` 不过并落码，**不进 #27**；`post` 只查结构不查"工具是否存在"（输入面读不到工具目录）。
2c. **`verify` 默认零成本**：未配校验命令的工作区只选中 `vf-noop`，该节点不发 eff、不花 token；配了命令的工作区选中 `vf-<ws>` 并跑真命令。
2d. **`verify` 不阻断收口**：校验失败仍 `commit`（已写文件照常落账），报告进上下文并由 `loop.when` 触发下一 iter。
2e. **池词汇完整**：`join` / `subagent` 契约从第一天存在且各有 `scope:global` 实例 ⇒ 不变量 2 / 3 / 6 可机械通过（即使种子图未接线它们）。
3. **分段执行**：图执行住服务内循环，不产生宿主 eval 重放；节点经 `port.call` 顺序派发，每步至多一个节点调用。
4. **热生效与换代边界**：写图 / 改阈值 / 加子代理 / 加工作流（composite）= 进程不动、身份数不变；改 `pre`/`post`/`when` 判定代码 = 换 execute = 换代（服务自驱既定代价）。
5. **分支真省预算**：未触发分支的 Scope **0 计费、不进执行流**，只记聚合计数。
6. **拒绝路径可还原**：任一 Scope 拒绝 ⇒ 短路到 sink 且落带错误消息；`trace.refused_at` 能还原"在哪个 `node_index`/`iter` 因什么码拒绝"。
7. **循环有界**：达 `max_turn_iter` 仍在派发 ⇒ 落 `budget` 码并收口，**不静默截断**。
8. **`scope` 强制**：B 工作区会话下 `scope:{workspace:A}` 的实例**不进候选集**；删到只剩 workspace 实例 ⇒ 写期拒 `last_global_instance`。
9. **自治不能静默完成**：L1 出口只有过 `post` 的 outputs 或带码 refusal；反复打满迭代上限的 Scope 运行时正常收口但 `trace` 记打满标记，`evolve-metrics` 能据此产 `no_progress` 证据。
10. **互联不越界**：跳往 `links` 外 ⇒ `link_denied`；互联边破 DAG ⇒ 写期拒；每次跳转有 `link_taken`。
11. **六条不变量与四条演化规则生效**：含 `llm_chain_max`（提交三连 LLM ⇒ 写期拒）、审批段不可绕过、`derived_from` 缺失 ⇒ 拒、diff 超限 ⇒ 拒。
12. **坏图必终止**：构造"永不到 sink"的图 ⇒ 达上限后 `refused`，宿主不挂死；#44 能读 trace 发 `orchestration.unhealthy`、#17 能回滚成功。
13. **提问往返（#48）**：模型调 `question` 工具 ⇒ `question_pending` 为真 ⇒ `loop.when` 为假 ⇒ 本 run 走 sink 正常结束（非 `waiting`）；用户作答后宿主按 `resume_cursor` 触发新 run，答案作为工具结果回灌、解释器从游标恢复继续；与 `approval.wait` 同源跨 run 机制。

---

## 跨插件登记

- **#14 chat**：版本提升（本插件替换其管道；命令面仍归 14；**#14 `pins` 新增 `loop-policy`**，入口 term eff `loop-policy.interpret`）。
- **#35 agents**：instance 加人格字段（prompt/model/decoding 的 pin）+ `scope` 字段；本插件 `bindings.agent` pin 它；**实例仍不带执行权**（发不发 eff 由本插件决定）。
- **#36 skill**：加 `scope` 字段（与 Scope / 人格同形）。
- **#41 workspace**：本插件投影读 `workspace_id`（经 #11 当前会话），用于 `scope` 过滤。
- **#26 / #32 / #39**：审批往返与"编排变更"待审批种类。
- **#17 ui-settings**：S13 编排 tab（图只读视图、Scope 名录、健康只读视图、回滚、进化台账）；`orchestration.unhealthy` 由 #44 发（非本插件 term）。
- **#38 ui-notify**：编排变更待审批、编排连续失败（#44 发）两类事件。
- **#43 `evolution` / #44 `evolve-metrics` / #45 `orchestration-admin`**：轨迹/证据/提案/判定的落点、证据聚合（pin #44）、agent 面编排管理。**两层分签**：#44 只产证据不提案、#45 只产提案不产证据不产写。**v1 闭环（2026-09-19）**：#33 服务触发 `evolve.propose` LLM Scope 产提案；#44 `shadow` 方法跑影子回放（据 #43 `directives_summary`/`ctx_summary` + 经 `host` 能力类 `audit` 取的 `EffectAudit` 回灌）；门禁三道（机械闸 = #33 服务本地 / 影子 #44 / 人闸 #32/#39）。
- **#48 question（2026-09-19 集成）**：`tool.dispatch` 派发 `question` 工具后 `loop.when` 因 `question_pending` 不 loop、本 run 走 sink 结束；作答后宿主按 `resume_cursor` 触发新 run 回灌答案。种子判定 `question_pending` 已加。
- **#42 `plugin-admin`**：源码写不经本插件的图数据面；但其 `write` 与 #45 的 `propose` 同受「审批段不可绕过」约束。
- **宿主待补能力**：投影引用闭包解析（复用 #11/#21/#35 同一条）、审批挂起/续跑、只读审计面——**均已登记，本插件不新增宿主动词**。
- **线程设计（2026-09-19）**：`subagent` / 协作契约在 **run 级并发**下执行（宿主改动登记：run 级并发 + 提交队列 + 乐观校验，见 `host.md` §五 写者）；`context.assemble` 节点写 `bag.thread_kind` / `bag.parent_summaries` / `bag.task_prompt`（含 inbox 未读消息）；子发 `decision_request` 时**唤醒父线程**（按游标触发新 run，同 #32）；工作流线程的步骤状态供 #18 步骤卡（`workflow.step` 事件）。**本插件不提供线程控制**（线程数据 owner 是 #11、run 生命周期归宿主，见 `docs/plans/threads-design.md` §三）。
