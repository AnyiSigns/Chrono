# ChronoAgentGraphContract：契约与图（设计）

> 本文是**设计**（契约与图）：节点池与能力契约、图文法、状态与通信；**不含实现步骤、算法伪代码与具体数值**。
> 本文只引用设计文档，不引用任何计划文档。
> 总览与纲领见 `docs/chrono-agent-graph.md`；控制与运行时见 `docs/chrono-agent-graph-runtime.md`；进化与账本见 `docs/chrono-agent-graph-evolution.md`。

---

## 一、节点池与能力契约

**声明式节点池**：池子是一份**数据**（清单式 def），不是代码。

```
NodeDecl = {
  node_id,                    // 实例 id（开集）
  contract_ref: Hash,         // 它实现的 Contract（= 能力类，闭集 append-only）
  implementation,             // llm | tool | trainable | composite
  bindings: {                 // 每项都是 pin(hash)，内容不内联
    prompt?,                  //   提示词 def（LLM 节点必填）
    model?,                   //   模型 id / provider / 版本（含 reasoning variant，可逐实例配）
    decoding?,                //   temperature / max_tokens / stop / tool_choice
    tools?,                   //   工具绑定与版本
    context_policy?,          //   装什么进上下文 + 预算与权重
    retry_policy?,            //   L1 迭代上限 K / 退出条件 / L2 budget_split（pin；热改走 put(slot=binding.*) 切版本）
    weights?,                 //   trainable 节点自身的模型权重世代（≠ 控制层三模型权重）
    subgraph?,                //   composite 节点折叠的子拓扑 def（结晶产物必填；pin）
  },
  cost_model: { tokens?, calls?, tool_calls?, walltime? },  // 解码期预算 mask 先验，不是计费真源
  autonomy: L0 | L1 | L2,     // 自治档位
}
```

**`composite`（结晶载体，必须有独立载体否则结晶无落点）**：`composite` 实例的实现 = **执行 `bindings.subgraph` 里 pin 住的子拓扑**。
四条不变量：① 子拓扑内部**逐节点照常执行、照常按实测 `EffRequest` 计费、照常入轨迹**（事件带 `parent_node_index`），
折叠**不减少实测成本**；② `touches_effects` / `can_delegate` / 生效 `determinism` / `cost` / `idempotent` 由子图按
§一「结晶不变量」聚合，不得自行声明更强档；③ 内部节点不进外层 `sig(topology)`、不占外层 `MAX_NODES`/`MAX_EDGES`，
但**占 `MAX_DEPTH` 的等效深度**（= 子图深度，防结晶绕过深度上限）；④ 子图内部的 `any` 端口选边照走路由，
内部 slot 不泄漏到外层（与 L2 子图同一隔离规则）。
→ 所以「结晶使 `H` 下降」只降**外层可寻址图的复杂度**（编排模型要生成的 token 长度），
**不降执行成本**（`cost_exec` 照实计）；两者不冲突，也不构成"结晶免费"。

**`trainable` 节点的权重通道（与控制层分开记账）**：`bindings.weights` 换代属**绑定变异**（不占生长额度），
与"控制层三模型权重变异"是两条通道；`trainable` 节点参数量**不计入控制层容量上限**，单列进 manifest 与报告。

### 1.1 节点契约

```
Contract = {                        // 规范形哈希 = contract_id = 编排模型看到的能力类
  contract_id,
  role_tag,                         // 能力类的语义标签（append-only 枚举；供 manager 归纳与报告分档，不参与匹配）
  touches_effects: bool,            // 是否触达效果端口（fs/exec/net/model）
  can_delegate: bool,               // 是否可发起 L2+ 委派（含子图）
  inputs:  [ { name, type, role?, required, cardinality: 1|n, binding_mode: all|any, optional_read?: never } ],
                                    // 走边读；all=汇聚(AND)，any=候选(OR)；any ⇒ cardinality=1
  outputs: [ { name, type, role?, cardinality: 1|n } ],     // 写自己的 slot（单写者）
  reads:     [ { key: SharedRef, optional?: bool } ],        // 可读的共享上下文键（只读）；optional ⇒ 可被 L1 request_input 请求
  delegate_reads?: [ SharedRef ],   // ⊆ reads.key；L2 子图可继承的 shared 子集（未声明不得注入）
  publishes: [ SharedRef ],         // 可发布到共享上下文的键（受控动作）
  pre:   Term,                      // 前置条件：不满足则节点可合法拒绝
  post:  Term,                      // 后置条件 = 节点级验收器（dense 信号的唯一来源；局部成败/预算消耗为过程特征、不并入 dense）
  refuses: [ RefusalCode ],         // 合法拒绝码：只能引用全局 append-only 码表，不得自造（见铁律 4）
  effects: { ports, methods, caps },// 声明需要的能力；越权即拒（不扩权）
  idempotent: bool,                 // L1 重试与宿主幂等缓存依据
  cost: { tokens?, calls?, tool_calls?, walltime? },  // 能力类成本先验（解码期 mask）；与 cap 四维对齐
  determinism: 'exact' | 'audited', // 生效档位 = 三元组解析后取**较弱者**（全序 exact ≻ audited，取 min = audited 侧）
  canary_set,                       // 金丝雀任务集 ref（按契约定义；滚动统计按实例，不进 NodeDecl）
}
```

> **`determinism` 全序方向（写死，防"取 min"读反）**：全序为 `exact ≻ audited`（`exact` 更强）。
> "取 `min`" = **取更弱者**，即任一环节为 `audited` ⇒ 生效档位 `audited`。文中所有 `min_effective_determinism`
> 一律指该方向；`'exact'` 只在**全部**环节均为 `exact` 时成立。
>
> **`post` 的判定输入面（写死，否则 post 不可复算）**：`post` 只能引用 ① 本节点 `outputs` 的 artifact 内容与
> `type`/`role`；② 本节点 `inputs` 解析到的 artifact；③ 本节点 `reads` 解析到的 shared 版本；④ 阈值叶 `theta.*`；
> ⑤ 本步 `EffectAudit` 的**声明字段**（如 `exec.exit_code`、`test_report.passed/total`）。
> **不得**引用任务级 `expected`、隐藏测试内容、其它节点的 slot、全局统计或预算余量
> （引用 `expected` ⇒ 节点级验收变成偷看答案；引用预算 ⇒ dense 标签随预算漂移、不可复算）。
> 违反者在契约解析期即拒（池不变量校验）。

**两级成本与两套分类（不许混用）**

- **成本两级（先验 ≠ 真源）**：`Contract.cost` = 该**能力类**的成本先验；`NodeDecl.cost_model` = **实例**覆盖值
  （缺省回退契约 `cost`）。二者**只作解码期预算 mask 的估计量**与 cap 拒发前的 `estimate_d` 上界，进 manifest 便于对照。
  **`cost.walltime` 只作 `walltime` cap 的拒发估计，不进 `cost_exec`**（与 §2.2 成本标量化一致）；
  先验四维的初值由**同契约在 dev 上的实测 p90** 回填、pin 进池版本（用合成任务标定，避免手写数字）。
  **cap 执法、`cost_exec`、`used` 一律按该步实际发出的 `EffRequest` 审计之和**（见 §2.2 计费口径）；
  不得用 `cost_model` 代替实测记账。先验与实测的偏差单列 `cost_model_error`（系统性低估 ⇒ 解码期过度放行 ⇒
  `BUDGET_STOP` / `incomplete` 增多，作升级证据候选）。所有 cap 指实例侧**实测**记账。
- **分类两套、正交**：`Contract` 的 `touches_effects` / `can_delegate`（两轴效果语义，属能力类）与
  `NodeDecl.implementation`（`llm|tool|trainable|composite`，执行载体，属实例）。约束（缺一即拒）：
  `trainable` ⇒ `touches_effects:false` 且 `can_delegate:false` 且 `determinism:'exact'`；
  `tool` ⇒ 触达端口时 `touches_effects:true`、否则 `false`；
  `llm` ⇒ **`touches_effects:true`**（`model` 端口即效果端口，见下）**且 `determinism:'audited'` 且 `idempotent:false`**；
  `composite` ⇒ 三轴按子图聚合（§一「结晶不变量」），不得自行声明更强档；
  `touches_effects:true` 或 `can_delegate:true` ⇒ `determinism:'audited'`（效果与决策必须留痕）。
- **`model` 端口是效果端口（写死，堵 memo 自欺）**：沙箱默认无网、网络**只在 `model` 端口** ⇒ `model` 属
  `{fs, exec, net, model}` 效果端口集。因此 **`implementation:'llm'` 的节点一律 `touches_effects:true` /
  `determinism:'audited'` / `idempotent:false`，永不进 memo 短路**——`temperature=0` 在真 provider 下**不保证**
  逐字节一致（隐式版本升级、非确定内核、batch 差异都会改字节，这正是漂移检测存在的前提），
  把 LLM 当可 memo 会让**真实漂移被短路掩盖**。原"temperature=0 且审计回灌齐备时方可声明 `exact`"的例外条款**已删除**。
  → 由此 memo 只服务 `trainable` 与**不触达端口的** `tool` 节点；`composite` 仅当子图内**全部**节点满足该条件时才可 memo。
  → 代价（明写）：两个同契约同输入的 LLM 节点会**真重复计费**。这不靠短路解决，靠 ① 图设计（多路回答必须显式建模为
  扇出-聚合 `cardinality:'n'` + `vote`/`judge`/`merge`）② `wasted_step` / `redundant_step_rate` 指标暴露 ③ 成本惩罚
  `λ·cost_exec` 自然抑制。

**五条铁律**

1. **能力类 ≡ 契约**。"新节点只注册能力"的精确含义 = 新实例声明它实现哪个**既有** `contract_id`；
   契约集 append-only ⇒ 可寻址面永不变化。
2. **契约不可变**。改 `inputs`/`outputs`、改 `pre`/`post` 的**判定式结构** = **新 `contract_id`**（不是改旧类）；
   否则等于偷改可寻址面。`post` 两层拆分，不可混：
   - **(a) 判定式结构**（算子、比较关系、字段引用）属契约、不可变；改它 = 新 `contract_id` ⇒ 触发专家追加 +
     arch bump + 重训 + 门禁重跑。
    - **(b) 阈值参数 θ**（如"通过率 ≥ θ""延迟 ≤ θ"）走 `put(slot='threshold')`、**回合锚冻结**、可版本化热改
      （`set_active` 切版本），**不**触发新契约、不重训。调阈值只影响下一轮。
3. **`pre`/`post` 是可执行 term**：判定式结构以数据身份进库、**不可热改**（改即新契约）；阈值参数以
   `put(slot='threshold')` 入库、回合锚下可热改可回滚可审计。`post` 就是节点级验收器——**dense 训练信号、漂移判定、
   路由反馈全部出自它**；没有它，dense 信号无来源。账本无 `put_pre`/`put_post`：判定式走
   `declare{kind:'capability'}`，阈值走 `put(slot='threshold')`。
   **结构 vs 阈值的自动判别（写死）**：`Term` 解析为规范 AST；**阈值槽** = AST 中带名字的数值叶
   （如 `theta.pass_rate`），只有这些叶可被 `put(slot='threshold')` 按名替换。**结构指纹** = 把阈值叶抽象为占位符后的
   AST 规范哈希；`put` 后若结构指纹变化（改算子 / 比较关系 / 字段引用）即判**结构变更** ⇒ 拒绝，
   必须走 `declare{kind:'capability'}` 生成新 `contract_id`。
4. **拒绝是一等输出**：`refuses` 码表 typed 且可路由。节点不许用异常表达"我不该做/做不了"，否则路由学不到东西、
   L1 的"拒绝并给原因"没有落点。
   **拒绝码必须取自全局 append-only 表（写死，否则跨契约失败聚类不成立）**：`RefusalCode` 是一张**全局枚举**
   （走 `declare`，与 `type_id` / `role` 同机制），`Contract.refuses` 只能**引用**其中的码、不能自造。
   理由：外环「失败模式聚类」是能力缺口证据的**主要来源**，而聚类必须跨契约可比——
   若每个契约自造码（`A.cannot_parse` / `B.parse_failed`），同一失败模式在 32 个契约里散成 32 个互不相识的码，
   聚类只能退化成按契约分组，"缺什么能力"就问不出来了。
   **初始码表（六类，append-only 可扩展）**：
   `pre_unsat`（前置不满足）、`input_insufficient`（输入不足，含 `request_input` 未获供给）、
   `capability_mismatch`（这不该我做）、`budget`（预算不足）、`undeclared_read`（越权读，属断言性拒绝）、
   `downstream_refusal`（上游拒绝传播）。
   每个码带 `retriable: bool`（L1 是否值得重试：`input_insufficient` 可，`capability_mismatch` 不可）与
   `attributable_to ∈ {node, graph, task, budget}`（聚类维度：`capability_mismatch` 归 `graph`——是编排选错了节点，
   不是节点不行；这条区分决定证据指向编排还是指向池）。
   **节点可在码之外附自由文本 `detail`**（进轨迹、供 manager 语义归纳），但**聚类只用码**，不用文本。
5. **效果声明 = 权限上限**：契约里没声明的端口/方法，运行时就不注入，调用即拒。这是"不扩权"的落点，
   也是"自治只能花预算、不能拿权限"在契约层的实现。

**校准语义**：`calibration` = 节点**预测置信 vs 实际通过率**的校准误差（ECE）。来源是契约可选的 `confidence`
输出位——`outputs` 可声明一项 `{ name:'confidence', type:'prob', cardinality:1 }`（值域 [0,1]，节点自报对该次
产物 post 通过的概率）；bin 划分、加权与 `n` 一起入 `health`。**无 `confidence` 输出的节点 ⇒ `health.calibration`
恒为 `null`**——不得用 post 的 0/1 verdict 凑 ECE（那是"节点-任务一致性"，不是校准）；对此类节点只判成功率/
延迟漂移。`type:'prob'` 进类型系统。
**`confidence` 端口不进数据流（写死）**：它是**旁路观测位**——不得被任何 `LINK` 消费、不进 `sig(topology)` 的
端口匹配面、不计入"唯一匹配"的候选对（否则每个契约都多一个 `prob` 端口，`LINK u→v` 全面歧义、显式端口对吃满 token）。
运行时把它直接写进 `health` 派生表与轨迹。要让下游读置信，必须显式声明一个**普通** `prob` 输出位（换个 name），
两者互不影响。

**幂等 ↔ 确定性对齐（堵 memo 误用）**：`idempotent:true` ⇒ 必须 `determinism:'exact'`（产物逐字节可复现，
memo 才能合法短路复用）；`determinism:'audited'` 的节点一律 `idempotent:false`、调用必须带 `variant_index`。
**校验点不在契约层，而在 `(contract, 解析后的 bindings, decoding)` 三元组解析之后**——同一 `touches_effects:false / exact` 契约的实例
若绑定 `temperature>0` 的模型或非确定工具，即判 `idempotent:false`（契约层单独通过不算数，否则 memo 会非法短路）。
因此契约的 `determinism` 是**能力类允许的最强档**，**生效档位** = 按三元组解析后取**较弱者**（见上文全序方向）；结晶合成与生长门禁
一律用生效档位，不用契约声明档。
**非确定工具的判据（写死，否则"非确定"是感觉）**：`tool` 绑定被判 `determinism:'audited'`，当其 `effects.ports` 含
`{net, model}` 任一、或 `methods` 含**写类方法**（`fs.write`/`exec.*`）、或工具 def 显式标注 `nondeterministic:true`
（读时钟 / 读随机 / 读环境）。仅含 `fs.read` 且未标注者可为 `exact`。该判定在**解析期一次算出**并 pin 进 manifest，
不在运行时猜。

**端口绑定谁决定**：绑定属于拓扑，**不交给运行时猜**。

- 每个契约的端口在生成期按**声明序** `0..k-1` 规范化编号，token 空间小且稳定（契约不可变 ⇒ 编号不漂移）。
  `inputs` 与 `outputs` **各自独立编号**（`u:2→v:0` 中 `2` 是 `u.outputs` 下标、`0` 是 `v.inputs` 下标）。
- **唯一匹配自动补齐**：`LINK u→v` 编译成唯一合法端口对，只花一个 token。
  候选集**排除** `confidence` 旁路位；双方均声明 `role` 时先按 `role` 相等过滤。
- **歧义时要求显式端口对**：`LINK u:2→v:0`。
- **已连满的端口不再是候选**：`in_degree(v,ip) < cardinality_max(v,ip)` 是候选条件之一，
  故同一对 `(u,v)` 的第二条边可能因首条边占满 `cardinality:1` 端口而唯一匹配到另一对。
- "歧义即拒"不可取（浪费预算，而歧义稀少）；"运行时确定性优先序"更不可取：它把一部分数据流交给运行时排序规则 ⇒
  **拓扑不再是唯一控制面**，且模型本意被悄悄替换成别的端口，只表现为成功率下降、归因不出。
- 端口对进 `sig(topology)`：选错端口就成为可去重、可对照、可回滚的**结构差异**。

**三条闭/开集铁律**：

1. **能力类 = 闭集 append-only；节点实例 = 开集**。编排模型寻址**能力类（= 契约）**，池子把契约绑到实例实现。
2. **新节点只注册能力**：不得改变路由表、不得改变其它模型的结构、不得改变可寻址面。
3. **契约数有上限**（与专家数上限同阶，具体值住账本）。append-only 不等于无限增长——触顶后要么走升级阶梯
   「控制层容量」档扩容（arch bump + 重训），要么把新能力并入既有契约的 `role`/子类型，不允许静默突破
   （否则 MoE gate 维度与专家预算失去上界）。

**为什么 `bindings` 必须 pin 而不是内联**：

1. **结构性依赖只走 `pins`**。提示词 def 是独立 def，节点声明只持哈希 ⇒ 同内容只存一份、闭包 = 沿 `pins`
   只读遍历、`stale()` 判失效（改提示词 ⇒ 旧绑定失效）。
2. **归因**：若把提示词内联进 `NodeDecl`，改一个词就换 `H(NodeDecl)` = 池子里多出"一个新节点"，
   于是**提示词消融（prompt A/B）与漂移归因都做不了**。pin 住之后节点身份不变、绑定换代，可以问
   "同一节点、同一拓扑、只换 `prompt_pin`，S 变多少"。
3. **回退**：换 pin = 换版本；回退是 `set_active` 一条追加，不是重写正文。

**三级内容必须分开**（否则轨迹既不可重放也不可蒸馏）：

| 级 | 内容 | 住在哪 | 谁记录 |
|---|---|---|---|
| 节点身份 | 角色提示词、few-shot 模板、解码参数 | `bindings` 里 pin 住的 def | 池版本 |
| 每次调用装配 | 上下文策略现场拼进提示词的片段 | 运行时 | 逐次入轨迹（连同 `prompt_pin`） |
| 外部输入 | 检索片段、记忆召回、文件内容 | 节点外部 | `EffectAudit` + 轨迹 |

**变异通道三分**（对应"什么可训、什么可长"）：

| 通道 | 对象 | 占生长额度？ | 触发 |
|---|---|---|---|
| 权重变异 | 控制层三模型（可训） | ❌ | 蒸馏 / 微调 |
| **绑定变异** | **llm 节点的提示词·模型·解码·工具绑定** | ❌ | 搜索 / 提案（这就是"不可训节点"的进化面） |
| 生长变异 | 新能力类 / 新节点实例（含结晶） | ✅ | 能力缺口证据 |

→ LLM 节点不可训，**提示词就是它们唯一的进化面**；这就是 `prompt` 必须有独立版本身份的原因。
轨迹里不记 `prompt_pin`，蒸馏样本就无法归因，绑定变异也就无从对照。

**生长额度（每回合，住账本）**：生长变异占用额度，绑定/权重变异不占。**契约级与实例级各有一个上限，取值住账本**
（新 `contract_id` 含结晶记契约级；新 `NodeDecl` 含结晶那 1 个记实例级）。超额提案本回合拒、
记 `note`，证据保留可下回合再提。一次只采纳有限生长，才能把增益归因到「这一条」；额度不是证据门的替代——
无证据仍直接拒。

**三个概念别混**：`Contract`（能力类，闭集 append-only，**编排模型的寻址单位**）
→ `NodeDecl`（实例，开集，同契约可有多个实现）→ `MoE expert`（属于控制层，但其边界**也是契约**）。

**结晶必然是一次契约扩展**：把子拓扑折成单节点，必须为该节点**新建完整契约** + 一个 `implementation:'composite'`
实例（`bindings.subgraph` pin 住被折叠的子拓扑），合成时保持下列不变量：内部闭环的 `reads` 不进新契约，但内部首次发布**之前**被读的键必须保留；
`publishes` / `refuses` / `effects` 取并集（`effects` 取并集不取子集，否则丢能力）；`pre` 取子图入口前置的合取；
`post` 取**所有活动路径都执行**的节点的过程 post 合取（AND 骨架 + sink），**不得**并入仅存在于部分 OR 分支上的 post
（否则结晶节点会被未走分支的 post 误杀），**不得**写成任务级验收式（任务级验收永远只在 `exit` 触发）；`cost` 取各节点
实例 `cost_model`（缺省回退契约 `cost`）沿**最长路径**的聚合上界（这是解码期 mask 用的先验上界，不是活动子图实测；
实测仍走 `EffRequest`）；`idempotent` = 各节点生效档位**全为** `exact` 时 true、否则 false；
`touches_effects` / `can_delegate` 取各节点布尔值的**或**；`determinism` 取各节点**生效档位**中的**较弱者**。
**`role_tag`** 由 manager 提案给出、进 append-only 枚举。
**深度记账**：结晶节点在外层按 `depth_equiv = 子图深度` 计入 `MAX_DEPTH`（不是按 1 计），否则反复结晶可无限绕开深度上限。

**结晶的收益边界（写死，防"结晶 = 免费提速"的误读）**：结晶降的是**编排模型要生成的结构复杂度** `H`
（外层 `|V|+|E|` 下降 ⇒ token 更短、搜索空间更小、`sig` 去重更强），**不降执行成本**——`composite` 内部逐节点照常执行、
照常按实测 `EffRequest` 计费。因此结晶的可证收益是 ① `H` 下降 ② 生成端方差下降 ③ 该子结构成为可寻址的一等能力
（可被 gate 选中、可被 motif 检索）；**若报告里出现"结晶后 `cost_exec` 下降"，只可能来自路径变化，必须单独归因，
不得记作结晶收益**。

结晶契约合成是决策层（见《进化与账本》）的核心职责。契约 append-only ⇒ **结晶 = 契约扩展 + 新实例，两件事一起做**，
因此必然触发：专家追加 + gate 追加式扩展 + arch bump + 重训 + 门禁重跑。所以"结晶不增熵"指的是
**结构复杂度 `H` 下降**，不表示"不动可寻址面"——两者不矛盾，但必须**一起记账**。

**冷启动**：新能力类配**未知能力兜底槽**（零初始化）；新实例挂已有能力类时，由池内同能力类实例的成功率统计
竞争上岗（无需改控制层）。

**同契约多实例的实例选择规则（必须写死，否则不可复现）**：编排模型**只输出契约**，**不输出实例 id**
（否则开集实例漏进 token 空间，与「可寻址面 = 契约闭集」「控制层 dims 与实例数无关」冲突）。
实例由运行时按下面的确定性规则选；A/B 评估由**评测 harness 强制绑定实例**，不经解码器。

1. **健康分确定性排序**（字典序）：`(shadow 升序, success_lower_bound 降序, cost 升序, node_id 升序)` 取首。
   `shadow=true`（未转正）或 `n=0` 时 `success_lower_bound=0`，排所有已转正实例之后。
   **禁止**对 `success_lower_bound` 取最小（那会优先最差实例）。
2. **A/B 强制**：评估绑定变异时必须**强制指定实例**，不许走默认规则——否则绑定效果与实例选择混淆。
3. **选择结果逐次入轨迹**（`chosen_instance`），否则"换了实例"与"换了模型"分不开。

**节点健康与金丝雀**：金丝雀集**按契约定义**（`Contract.canary_set`；同一契约的所有实例共用同一集合，保证可比），
滚动成功/校准/延迟统计**按实例**计算、落 **events/health 派生表**——**不进 `NodeDecl`**，否则每次统计更新都会改变
`H(NodeDecl)`，把噪声伪装成"新节点"。漂移最现实的来源是某实例的绑定被 provider 静默升级。该统计是**漂移判定的唯一输入**。
没有金丝雀集，"节点漂移"只能是感觉。

---

## 二、图文法

**不变量**：

1. 节点 = 一次能力调用，带 typed 契约。
2. 边 = **端口到端口的映射** `(u, out_port) → (v, in_port)`，类型必须兼容；图**无环**。端口绑定是拓扑的一部分
   并进 `sig(topology)`——**数据流完全由拓扑决定**。**边的 AND/OR 语义必须显式**（否则"条件超图"与"路由选边"
   无法落地）：入端口声明 `binding_mode: all` ⇒ 所有入边**全部**满足（AND，用于 `cardinality:'n'` 汇聚）；
   `binding_mode: any` ⇒ 入边互为**候选**，运行时由路由**恰选一条**（OR）；**`any` 端口必须 `cardinality=1`**
   （"恰选一条"与 `n` 汇聚互斥，组合非法）。拓扑因此是 **AND-OR 图**，
   实际执行的是满足 `all` 端口与所选 `any` 边的**最小闭包**（= 活动子图）。`any` 端口必须至少有一条候选边。
   **`cardinality` 与入边度是两件事（写死，否则 OR 无从选）**：`cardinality` 约束**运行时注入该端口的 artifact 数**
   （`any` 端口恰 1 个）；**入边度**约束**拓扑上的候选边数**（`any` 端口允许 `1..MAX_ANY_CAND`）。
   若把 `any` 端口的入边度也限成 1，就只有一条候选、路由无可选、OR 分支不存在。
   `all` 端口两者一致：`cardinality:1` ⇒ 入边度 1；`cardinality:'n'` ⇒ 入边度 `1..MAX_FANIN`。
   `MAX_ANY_CAND` / `MAX_FANIN` 住账本。
3. `entry` 禁入（无入边）、**`sink` = 生成序最后一个节点，唯一、`exit` 只收它的 outputs**、
   **图至少含 1 个节点**（`entry→exit` 直连的零节点图非法）。
   **闭合 = required 入边全连 ∧ 非首节点 ≥1 入边 ∧ 每个节点有向路径到 `sink`（all_reach_sink）∧ |V|≥1**。
   悬空节点（达不到 `sink`）非法，解码期补齐或 `incomplete`，不得产出。
   **`sink` 唯一性写死**：`exit` 不是多汇聚点——`sink` 由生成序唯一确定（最后一个 `NODE`），
   其它节点必须有到 `sink` 的有向路径。要"多个终产物"就让 `sink` 用 `cardinality:'n'` 入端口汇聚，
   或用聚合契约收口；**不允许多个无出边节点并列充当终点**（否则"任务级验收读哪些产出端口"依赖运行时排序，
   验收面不唯一）。
   **无输入端口的契约只能作首节点**（非首位无法连入边）。**无环 ⇒ 活动子图的一条执行路径上任一节点至多执行一次**（命中者恰好一次、未命中 OR 分支者 0 次），故不设 `MAX_REPEAT`（原"单节点访问上限"在 DAG 下无落点，
   删除）；L2 **子图递归深度**由 `MAX_RECUR` 管，DAG 内不存在节点重入。
4. 所有路径收在 `exit`（= 任务级验收通道）；**任务级验收只读 `sink` 的产出端口，节点级判定只读 `post`**，
   两级不混。
5. 预算上限：节点数 ≤ `MAX_NODES`、边数 ≤ `MAX_EDGES`、深度 ≤ `MAX_DEPTH`、递归深度 ≤ `MAX_RECUR`。
   **`MAX_DEPTH` 按 DAG 最长路径计，`composite` 节点按其子图深度折算**（见 §一 结晶不变量）。

**活动子图的执行语义 = 拉式惰性（写死；OR 必须真省预算）**：从 `sink` 反向按需求驱动，**只执行被需要的节点**。

- **求值顺序**：`demand(sink)` → 对每个 `all` 端口求值其**全部**入边前驱；对每个 `any` 端口，
  **先由路由选一条候选边，再只对被选中的那条前驱求值**。选边发生在**候选产物产出之前**。
- **路由选边的 obs（因此不含候选产物内容）** = `{ 已产出 slot 摘要, 已执行能力集, 剩余预算三维,
  各候选边的静态特征（前驱契约 id / 该前驱的历史成功率 / cost 先验 / 距 sink 距离）, 当前子目标编码 }`。
  这是 OR 省预算的代价，**已写死、不得偷偷改成"先跑完再挑"**。
- **求值顺序的确定性**：同一节点的多个待求值前驱按**节点生成序（下标升序）**依次求值；
  `any` 端口的选边在该端口首次被 demand 时发生一次并记 `edge_choice`，**同一执行内不重选**。
- **`branch_not_taken`** = 未被任何 demand 路径选中的节点，**0 计费、不进轨迹执行流**（只记一条聚合计数）。
- **与扇出-聚合不重复**：`any` 端口是"**选一条**、只跑被选的"；要"**多路都跑再挑**"必须显式建模为
  `cardinality:'n'` 的 `all` 端口 + `vote`/`judge`/`merge` 聚合契约，**N 路全计费**。两套机制语义不同、不可互相顶替。
- **L1 请求追加输入不改变求值面**：`request_input` 只能取 `reads` 中 `optional:true` 的 shared 键，
  **不能触发新的前驱节点求值**（否则 demand 图在执行期变形、活动子图不再由拓扑+选边唯一决定）。

**类型系统**：采用 **nominal 类型 + `type_id`**。`inputs`/`outputs` 的 `type` 是一个 `type_id`（字符串，进契约
append-only 类型表，故类型集 append-only、`type_id` 不漂移）。兼容 = `type_id` 相等 **或** 显式声明的子类型关系
（类型表带 `subtypes`）；`cardinality:'n'` 汇聚要求所有入边 `type_id` 相等（子类型先规范化到最小公共超型）。
预留类型：`'artifact'`（默认产物）、`'verdict'`、`'refusal'`、`'prob'`。**端口另带 `role` 标签**
（如 `code`/`plan`/`critique`/`tests`），用于把"唯一匹配"从稀有变成常态——只有 4 个类型时默认 `artifact` 会大面积
歧义，显式端口对会吃掉 token。`role` 进契约 append-only 表，故不漂移。

**生成 = 受约束解码**：编排模型吐 token 序列，解码器只产出**语法闭合**图（闭合定义见不变量 3）；运行时**只机械校验、不做语义兜底**。
语法非法图（未闭合 / 类型不兼容 / 越上限 / 空图）计入图文法门禁，出现即解码器 bug。
语义层拒绝（publish 偏序、缺 join、汇聚无 LUB、entry 歧义）记 `compile_reject`，不计入图文法门禁，但必须报 `compile_reject_rate`。

**子图（L2 委派）**：子图是**拓扑的同一种表示**，同样过闸、同样计入同一本预算账。父节点把预算切给子图，
子图不得无界扩张；每次委派留一条审计记录（父节点、深度、分到的预算、结果）。

**结构代际**：拓扑的规范形哈希 `sig(topology)` 为**精确去重键**；另有 `family_sig(topology)` =
**节点/契约多重集签名**（忽略边），用作交叉域与"同多重集"族。**子图**另有 `sub_sig(sub)` = **诱导子图规范形哈希**
（节点按首次生成序重标号、边排序，只含子图边界与内部结构、不含父图节点编号），用作**结晶触发键**与 motif 库去重键。
三者不可混：`sig` 相同 = 同一张图（交叉无意义），`family_sig` 相同 = 同族不同拓扑，`sub_sig` 只对子图有意义。
结构版本随池版本与图文法版本 pin。

**`sig` 的规范化口径（写死，否则去重与安慰剂臂都不成立）**：`sig` **不做图同构规范化**——
按**生成序**重标号后取 `H(canonicalJson({nodes: contract_id 序列, edges: 排序后的 (i,out,j,in)}))`。
理由：图同构规范化是 NP-hard，且**生成序本身是模型输出的一部分**（同一结构不同生成序 = 不同 token 序列 =
listwise 目标里的不同样本），强行同构合并会把"模型学到的生成次序"抹掉。
代价（明写）：同构但生成序不同的图会被算作两张图 ⇒ **去重偏保守、`sig` 空间偏大**。
补偿：`family_sig` 已给"同多重集"族；EA 交叉与 motif 检索用 `canon_nodes`（按 `(contract_idx, orig_index)` 排序）
做**局部对齐**，不依赖全图同构。若报告中"同构重复图"占比超过诊断线（住账本），记诊断、作为"加规范化档"的升级证据候选。

### 2.1 语义钉死

1. **`entry` / `exit` 是虚拟边界，不是契约节点**：不进节点池、没有 `contract_id`、不占预算。`entry` 是初始
   artifact 的注入点，其 **typed 供给集** `entry_supply = [{type_id, role?}]` 由任务 spec 声明并 pin
   （每个任务至少提供 `'artifact'`）；首节点 `required:true` 输入必须能在此集合里找到类型兼容项，否则该契约
   在解码期被 mask。**池不变量**：池中必须始终保留至少一个只依赖 `'artifact'`（`inputs` 为空或全部可由
   `entry_supply` 满足）的 `touches_effects:false` 契约（通用兜底首节点）。这是"首节点 mask 后无合法节点"不可能发生的依据；
   删除/替换该契约即池不变量被破坏，门禁判红。
   **join 契约**：池中必须始终保留至少一个 `join` 契约（跨互斥 OR 分支的 `shared` 版本合并）；缺失则含跨分支 publish 的图无法通过编译期检查，生成器没有合法闭合手段。
2. **两级验收，绝不可混**：
   - **节点级（过程）** = `Contract.post`：逐步判定，产出 dense 信号、节点级 verdict / 拒绝码、漂移统计。
   - **任务级（终局）** = `exit` 时的**任务级验收器**（仓库状态 + 隐藏测试 + 测试文件哈希），产出 `pass@1`
     （**只有它决定 `S`**）与 `test_pass_fraction`（用例比例，只作诊断列）。
   节点级验收器永远不能替代任务级——否则等于让考生自己判卷。
3. **"验收通道"的口径** = `exit` 触发的那一条任务级判分路径（`exec` 跑隐藏测试 + 哈希校验 + 产物路径回写）。
   它**不是一个节点**，是一个动作。
4. **两轴语义 + 确定性档（原单值 `kind` 已拆）**：`touches_effects:false` = 不触达效果、可纯函数重算；
   `touches_effects:true` = 触达端口（`fs`/`exec`/`net`），必须审计回灌；`can_delegate:true` = 可发起 L2+ 委派
   （含子图），其决策与成本必须留痕。两轴正交，不再用 `pure/effect/agent` 单值兼任。

### 2.2 状态与通信

边只说"类型兼容"是不够的——必须写死**边上流什么、谁能读写、状态归谁**。但**"隔离"不等于"什么都看不见"**：
协作者必须能读同一份材料。正确切法是**可写面隔离、只读面共享**。

```
GraphState = {                          // 唯一状态对象，唯一写者是运行时
  task,                                 // 任务（不可变）
  shared: Record<SharedRef, Artifact[]>, // 只读共享上下文（协作面）；同键版本序列 append-only
  slots:  Record<SlotId, Artifact>,     // 单写者通信槽（点对点数据流）；SlotId = (node_index, out_port)
  budget: { remaining, spent },
  step,
}
Artifact = { id: Hash, type, role?, producer: { node_index, step, instance_id }, pins?, bytes_ref }
                                        // 内容寻址；type ∈ 生产者 outputs；bytes_ref = 内容哈希（大产物走 blob）
```

**三处标识必须区分（否则轨迹 join 不上）**：`node_index` = 图内生成序下标（拓扑唯一、进 `sig`）；
`node_id` = 池内 `NodeDecl` 实例 id（开集、不进图）；`contract_id` = 能力类。
**slot 键与 `producer` 一律用 `node_index`**（同一实例可在一张图里出现多次），
`instance_id` 另记于 `Artifact.producer` 与 `chosen_instance` 事件供归因。

**两块状态的分工**

| 块 | 里面是什么 | 谁能写 | 谁能读 | 可见性 |
|---|---|---|---|---|
| `shared` 共享上下文 | 任务 spec、repo 快照、公共检索语料、记忆召回、风格/惯例表、上一轮讨论摘要 | **只有运行时**（初始化、父图、或节点的**显式 publish**） | 契约里声明了 `reads` 的节点 | 显式 read-set，按 scope 继承 |
| `slots` 通信槽 | 节点产物（点对点） | 该槽的**唯一生产者** | 仅入边指向它的节点 | 由拓扑决定 |

**协作者怎么用**：多个节点读**同一份** `shared`（同一 repo 快照、同一任务 spec、同一讨论记录），各自写
**自己**的 slot，最后由聚合节点收敛——"共享大脑、私有工作台"。这是协作可用性的来源，同时不牺牲归因：
谁读了什么、谁写了什么全在契约里声明。

**八条状态规则**

1. **节点不持有跨调用状态**（L0/L1/L2 一律）。L1/L2 的循环变量调用私有、随调用结束销毁、逐步入轨迹。
   想记忆就必须显式落成 artifact 或走外部记忆输入。
2. **四类声明必须齐全**：`inputs`（走边读）、`reads`（读哪些 `shared`）、`outputs`（写自己的 slot）、
   `publishes`（发布到 `shared`）。**未声明的读一律不可见**。
3. **可写面隔离（单写者）**：节点只能写自己 `outputs` 的 slot 与 `publishes` 声明的 shared 键；
   同一 slot 任一步骤最多一个生产者；越界即拒。
4. **只读面共享**：`shared` 对声明了对应 `reads` 的节点可见且**只读**，不能就地修改。
5. **发布是受控动作**：更新共享上下文必须走 `publishes` + 运行时执行的发布（追加新版本 + 版本化，旧版本仍可被
   轨迹与 `pins` 指到）。发布是**公开事件**：进轨迹、可审计、可撤销。**同键发布的偏序铁律（否则重放非纯函数）**：
   同一 `SharedRef` 的所有发布节点两两之间**必须有拓扑偏序**（编译期静态检查判）——该约束是全局的，拓扑序语法不保证，
   故不能在解码 token 期 mask。节点读 `shared` 键 K 时，看到**拓扑上先于该节点且 publish 了 K 的节点中、
   偏序最后者的版本**——由拓扑唯一决定、**不依赖运行时调度顺序**。这是"状态是执行的纯函数"能在多发布者下成立的必要条件。
   **可见性与活动子图的关系（写死）**：读 K 的节点看到的是"偏序最后的**已求值**发布者"的版本；
   若该发布者落在未被选中的 OR 分支上（`branch_not_taken`），则**跳过它、取偏序上再前一个已求值发布者**。
   这仍由 `(拓扑, 各 any 端口的选边)` 唯一决定，不依赖调度顺序。
   **互斥 OR 分支例外（分支内 publish + join 合并）**：若两个发布者分属**互斥 OR 分支**，则二者无需可比；
   但**跨分支的版本合并必须收在显式 `join` 契约**处，由 join 按确定性合并规则产出唯一版本，下游只读 join 之后的版本。
   **"互斥"的静态判据（写死，否则编译期判不动）**：两个发布节点 `p`、`q` 互斥 ⟺ 存在一个 `any` 入端口
   `(w, ip)`，使得 `p` 只经 `(w,ip)` 的候选边集合中的一条边可达 `w`、`q` 只经另一条可达 `w`，
   且 `p`、`q` 除经 `w` 外无其它到 `sink` 的路径。**该判据是充分不必要的**：判不出互斥即视为**可同时命中**。
   编译期判定：`publish` 无偏序对且不满足互斥判据 ⇒ `compile_reject(reason="publish_order")`；
   满足互斥判据但下游缺 `join` ⇒ `compile_reject(reason="missing_join")`。
   代价（明写）：保守判据会拒掉一部分**实际上安全**的图 ⇒ `compile_reject_rate` 偏高。
   这是刻意选择——把"可能的重放不确定"换成"确定被拒"，比反过来安全；若该 reason 占比超过诊断线（住账本），
   作为"加强互斥分析"的升级证据候选，**不是**放宽判据的理由。
   **并行化前置**同样适用：并行档上升前，跨分支 publish 必须已改为 join 合并。
6. **无隐式通道**：不得经文件系统、环境变量、全局模块变量通信。工作区是任务级沙箱、不是节点间通道；
   要传文件产物，就把路径哈希显式写进 slot 或 `shared`。
7. **子图作用域**：L2 子图继承父节点显式传入的 slot 与（可选的）`shared` 子集，内部 slot **不泄漏**到父图；
   返回时只交回 `outputs` 声明的输出位。**继承的 `shared` 子集由父节点契约声明的 `delegate_reads`（其 `reads` 的子集）确定**——运行时按 `delegate_reads` 切片注入、逐次入轨迹审计；未声明键一律不可见（不得运行时动态决定子集）。
8. **值不可变、内容寻址**：写 = 新建 artifact；覆盖 = 版本化。大产物走 blob（只存哈希）。

**作用域必须限死（三处，否则跨任务污染 + 重放失效）**

| 项 | 作用域 | 越界的后果 |
|---|---|---|
| `shared` / `slots` / 已发布版本 | **单任务单次执行**（task-scoped） | 跨任务可见 = 任务间污染，且重放不再是纯函数 |
| `memo` 短路 | **单任务单次执行** | 同 `(契约, 输入)` 出现在两个任务时复用产物 = **跨任务答案泄漏** |
| 跨任务持久 | 只能走 **memory def**（显式、版本化、逐次入轨迹） | 想"记住"就必须付"可审计"的代价 |

**成本记账的唯一真源 = 成本事件流（写死；所有成本口径都是它的派生视图）**

原先并存九个成本概念（`cap` / `cost_exec` / `used_ext` / `search_cost` / `holdout_cost` / `verify_cost` /
`encoder_cost` / `ratelimit_wait` / `cap_overshoot`），靠**纪律**保证"搜索成本不重复计进 `cost_exec`"这类不变量。
纪律不可验证 ⇒ 改为**单一事件流 + 派生视图**，让"不重复计费"成为**构造性性质**：

```
CostEvent = {
  dim: 'calls' | 'tokens' | 'tool_calls' | 'walltime',
  amount: number,                       // 实测
  token_kind?: 'input' | 'output',      // 仅 dim='tokens' 时填；用于按输入/输出单价折算金额
  attributed_to:                        // 谁花的（正交分类，一条事件恰属一类）
      'graph_exec'                      //   图内节点执行（唯一进 cost_exec 的一类）
    | 'control_decode'                  //   控制层 decode（含 THINK）
    | 'encoder'                         //   固定 LLM 编码器
    | 'search'                          //   离线搜索展开
    | 'teacher' | 'manager'             //   外环 LLM
    | 'verify'                          //   任务级验收（判卷，不是做题）
    | 'ratelimit_wait',                 //   限速退避等待（只有 walltime 维）
  task_id?, round, run_id, node_index?, call_id?,
  counts_against_cap: bool,             // 是否受 per-task cap 约束
  at,
}
```

> `token_kind` 是**子维度**不是第五维：cap 向量仍是四维（`tokens` 维管总量），
> 输入/输出分开只用于**折算金额**与提示缓存命中率统计（两者单价差 3–6 倍，混在一起算不出钱）。
> `calls` 维的语义 = **实际发出的 LLM/工具请求次数**；控制层 decode 与编码器各自是独立调用，各记一条。

**九个旧口径全部降为查询（不再是独立记账面）**：

| 视图 | 定义（对事件流的过滤与聚合） |
|---|---|
| `cap` 执法 | `Σ amount where counts_against_cap ∧ task_id=T ∧ dim=d` 与 `cap_d` 比较 |
| `cost_exec(G)` | `Σ w_d · min(used_d, cap_d)/cap_d`，`used_d` 只取 `attributed_to='graph_exec'`、`d ∈ 三维` |
| `used_ext` | `attributed_to ∈ {graph_exec, control_decode, encoder}` + `search` 的 pro-rata 份额，四维 |
| `search_cost` | `attributed_to='search'`，按 `round` 聚合 |
| `holdout_cost` / `verify_cost` | `attributed_to='verify'`，按 `run_id` 的 holdout/dev 标记分组 |
| `encoder_cost` | `attributed_to='encoder'` |
| `ratelimit_wait` | `attributed_to='ratelimit_wait'`（恒 `counts_against_cap:false`） |
| `cap_overshoot_d` | `max(0, used_d − cap_d)`，同 `cap` 视图的 `used_d` |

**三条由构造保证的不变量**（原先靠纪律，现在可机械校验）：
① `attributed_to` 是**划分**（一条事件恰属一类）⇒ 任何一笔花费**不可能**同时进 `cost_exec` 与 `search_cost`；
② `counts_against_cap` 逐事件显式 ⇒ "退避等待不计入 walltime cap"不再是散落的但书，是字段值；
③ `Σ` 全事件 = 真实总花费 ⇒ **报告口径可对账**（各视图之和减去重叠应等于总量），对不上即记账 bug。
**预算账门禁的判据**因此从"人工检查各口径"变为"**事件流对账 + `attributed_to` 划分完整性**"。

**成本标量化**：`cost_exec` = 确定性三维 `{calls, tokens, tool_calls}` 的 `used/cap` 加权和（权重 `Σw=1`、住账本），
**不含 walltime**；消除"cap 向量"与"标量惩罚"的循环引用；权重取值随默认值入账。`walltime` 仍进 cap 硬停与 `used_ext`。

**计费口径（写死）**：计费 = 该步**实际发生的 `EffRequest` 审计之和**（不是 `cost_model`）。**未执行不计费**：`memo` 命中
（复用产物，`replay_publishes` 不额外计费）、`redundant_reject`（执行前拒绝：同键无 `variant_index` 递增、或本 `(node_index, step)` 已调度）、`branch_not_taken`（未进活动子图）
一律为 0；**已执行即按实际消耗计费**：合法拒绝（refusal）、失败、超时、预算触顶、以及**已执行但无新信息**的 `wasted_step`
都按已发出请求与已产生 token 计入，失败/超时/`wasted_step` 单列。`wasted_budget_rate` 的分子只含 `wasted_step`（已执行），
不含 `redundant_reject`（否则该比率恒为 0，防冗余门禁作废）。`greedy_completion` 计入本任务预算；控制层 decode token 按实际采样 token 数计入。
**cap 触顶的粒度（写死，否则"触顶"是模糊的）**：cap 检查在**每次 `EffRequest` 发出前**做一次
（`used_d + estimate_d(request) > cap_d` 即拒发并记 `budget_event(kind='cap_block')`），
`estimate_d` 用该步 `cost_model` 的**上界**；一旦拒发，当前节点得到 `refusal(budget)`、任务转入收口
（活动子图剩余节点记 `branch_not_taken`，任务判 `incomplete`）。
**已发出的请求超支照实计入**（真 provider 返回的 token 数可能超过估计），`used_d > cap_d` 的溢出量单列
`cap_overshoot_d`，进报告不进 `cost_exec` 分子截断——否则"触顶"会被伪装成"刚好用完"。

**L2 子图预算与深度**：父节点把 `budget_slice` **转移**给子图（父图剩余同步减少）；子图未用完的部分**不归还**
（避免"用不完就退回"诱发的预算囤积），但入账分开记 `父图消耗 / 子图消耗`。**深度**：父节点 `depth` 从 0 起，
委派子图 `depth = parent.depth + 1`，须 ≤ `MAX_RECUR`；**DAG 内 `MAX_DEPTH` 与递归 `MAX_RECUR` 是两套计数、不可混**。
子图持有**独立 `budget` 与 `step` 计数器**，父子以委派审计 join。

**为什么这样切**：隔离的真正目的是 ① 可归因（节点行为只由其**声明过的**依赖决定）② 可重放（状态是纯函数）
③ 无隐式竞态。**只读共享一条都不破坏**，而"全隔离"会把协作场景直接掐死；反过来，可写面一旦共享（全局黑板），
三条全废。所以共享只能共享"读"，不能共享"写"。

**状态是执行的纯函数**：`(任务, shared 初值, 拓扑, 池版本, 权重, 种子, 运行时版本, 审计回灌) → GraphState`。
重放不产生第二个 state；若有 effect 未回灌而 state 漂移 ⇒ 违反可重放门禁。**记忆不是状态**：长期记忆经
`context_policy` 从 `shared` 注入并逐次入轨迹。

**防冗余三条机制**（"3 个 LLM 节点依次回答同一个问题"必须在结构上挡住，不能靠祈祷）

1. **幂等 memo 短路**：**调用键必须含 `task_id`**（不能只靠"存储 task-scoped"的口头约定），**且必须含
   `reads` 解析到的 shared 版本**——否则同一任务内 shared 键被重新 publish 后会命中旧产物（静默错误）。
   契约 `idempotent: true` 时同键已算过 ⇒ **直接复用产物、不花预算**。**memo 命中时若该节点声明了 `publishes`，
   必须按同一产物重放 publish 事件（版本哈希不变、不额外计费）**——否则下游对该键的读取会解析不到本应存在的
   版本（静默错误）；publish 是产物的纯函数，重放不破坏幂等。
   **memo 的适用面（与上文 `model` 端口口径一致）**：仅 `trainable` 与不触达端口的 `tool` 节点（以及内部全为此类的
   `composite`）可 memo；**`llm` 节点一律不可 memo**。
   `idempotent: false` 的节点必须显式带 `variant_index`（"我要第 k 个候选"）；
   **L1 重试由 `retry_policy` 自动递增 `variant_index`**，不得裸重试；不带 `variant_index` 而同键第二次调用 ⇒ 判**冗余**并拒绝。
   **`variant_index` 的初值与作用域（写死）**：每个 `(task_id, node_index)` 的首次调用 `variant_index=1`，
   L1 第 k 次尝试 = k；`variant_index` 不跨 `node_index`、不跨任务复用。
2. **进展强制（两段，不可混）**：
   - **执行前 `redundant_reject`**（不计费、不调度）：同键第二次调用且未递增 `variant_index`；或本 `(node_index, step)` 已调度。幂等节点由 memo 先短路，不进本判定。
   - **执行后 `wasted_step`**（已执行、按实测计费，计入 `wasted_budget_rate`）：产出既无**新 slot 内容**也无**新信息**。
     新 slot 内容 = 写了未被 memo 命中的 artifact 且与该 slot 历史版本**逐字节不同**；新信息 = verdict / 拒绝码 /
     `edge_choice` / `input_request` / `autonomy_decision` 与该 `(node_index, step)` 历史**不同**。
   **DAG 下 `wasted_step` 的唯一现实来源（写死，防指标空转）**：无环 ⇒ 同一 `node_index` 在一次执行里只调度一次，
   故该判定只在 **L1 内部重试**（同 `node_index`、`variant_index` 递增、第 k 次与第 k−1 次逐字节相同且无新信息）
   与 **`composite` 内部节点**上触发。外层 DAG 节点的首次执行**永不**判 `wasted_step`
   （"首次执行"必然带来新 slot 内容或新信息）。因此 `wasted_budget_rate` 实质度量的是 **L1 空转率**，
   报告中须标注该口径，不得读成"整图冗余率"。
   `redundant_step_rate` 含两段（拒调度 + 空转）；`wasted_budget_rate` **只含** `wasted_step` 消耗。**冗余是可测的，不是感觉**。
3. **单写者 + 显式扇出**：同一 slot 在任一步骤**最多一个生产者**；跨节点写同名 slot ⇒ 拒绝（否则"下游读到谁"
   由执行顺序决定 = 隐式竞态，归因当场失效）。要多路回答同一问题，必须**显式建模为扇出-聚合**：输入端口
   `cardinality: 'n'` + 一个聚合契约（vote / judge / merge）消费全部 N 个产物。于是"3 个节点答同一题"
   变成一个**可对照的实验因子**（N=1 vs N=3 的效果与成本），而不是缺陷。

**router 必须看得见进度**：路由/编排的输入必须含**已执行能力集合、已写 slot 摘要、剩余预算**。
模型自己学不会"这个已经执行过"——没有进度特征，重复执行是必然，不是偶然。
拉式惰性下路由**看不到候选产物内容**（选边在候选求值之前），因此候选侧只给静态特征
（前驱契约 id / 历史成功率 / cost 先验 / 距 sink 距离），见 §二「活动子图的执行语义」。

**状态隔离与共享门禁（语义）**

- 写未声明 slot、写未 `publishes` 的 shared 键、读未声明 `reads` 的 shared 键、读未入边 slot ⇒ 拒绝。
- **诱饵测试（读隔离）**：往 `shared` 里塞不属于该节点 `reads` 的诱饵字段（含 `expected`、holdout 任务哈希等
  敏感键），断言节点输出**逐字节不变**。
- **共享正向测试（协作可用性）**：把同一份 `shared` 材料喂给两个协作节点，断言两者都读到。
  协作不是靠"看不见"实现的——这条是为了防止把隔离做成"信息窒息"。
- 同一步、同输入的重复执行必须产出逐字节相同的 artifact（带回灌效果者除外）。
- 每步读写集与发布事件必须可从轨迹重建：`(step, node_index, 读的 slot/shared 集, 写的 slot 集, 发布事件)`。
   **执行流一等事件**（`run_id` + `task_id` 作用域）：`chosen_instance`、`edge_choice`、`branch_not_taken`、
   `publish`、`memo_hit`、`redundant_reject`、`wasted_step`、`input_request`、`autonomy_decision`、
   `budget_event`、`delegate_audit`、`incomplete`。
   **生成流一等事件**（同 `run_id`，但无 `step`/`node_index`——它们发生在图存在之前）：
   `decode_fallback(kind)`、`decode_stop_kind`、`greedy_completion`、`think_stop`、`compile_reject`。
   **搜索流一等事件**（回合作用域，属 `search_cost` 记账面，不进单任务轨迹）：`invalid_crossover`、`gate_k_shrink`。
   三个作用域**不可混写进同一条轨迹表**：执行流按 `(run_id, task_id, step)` 追加，生成流按 `(run_id, task_id, decode_seq)`
   追加，搜索流按 `(run_id, round, rollout_seq)` 追加。混写会让 `step` 语义漂移、`wasted_step` 等按 `step` 聚合的指标算错。

---

