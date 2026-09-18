# ChronoGraph 计划：落地（UnDone）

> **设计口径在 `docs/chrono-agent-graph.md`（总览）及其机制文档 `-contract` / `-runtime` / `-evolution`；本计划写"怎么做"，含算法伪代码与具体数值。冲突时以设计为准。**
> 本计划只做 **ChronoGraph 实验**（`experiment/ChronoGraphLab/`，standalone、不接内核）。

---

## 目标

做出可跑的实验运行时：账本 + 声明式节点池 + 图文法 + 受约束解码 + 控制层三模型 + 搜索蒸馏 +
进化外环 + 门禁，用自造编码任务在**固定预算**下对照"现场生成拓扑"与"人工固定图"。
此后加能力只加**声明 + 实例**，不改框架代码。

## 前置

- `docs/chrono-agent-graph.md`（总览）及其机制文档 `-contract` / `-runtime` / `-evolution` 的设计口径已定稿。
- 确定性基础库（RNG / 规范序列化 / 哈希）已冻结。

## 本阶段口径

- 实现严格按设计口径；本计划的 A–J 是它的实现规格。
- 先 standalone，账本 `Entry` **字段形状**对齐内核（op 集合不同、迁移需 op 语义映射层），不做内核迁移。
- 只用合成任务与 toy 节点验证机制；真实能力插件后置。

---

## §0 · 与先例的关系与借用清单

> **为什么写这一节**：本方向已有大量先例（ADAS / 自演化 agent 图），且**主命题已有公开反证**（§0.4）。
> 这一节不是文献综述，而是三条执行纪律：
> ① **能被验证过的方案直接借**，不自创；② 明确本项目**真正需要自创**的部分；③ 明确**必须正面回应的反证**。
> 所有借用项在落地处标注来源，便于日后溯源与替换。

### 0.1 借用清单（按机制；"落地"列指向本计划的具体位置）

| 机制 | 借自 | 借什么 | 落地 |
|---|---|---|---|
| **拓扑搜索 = MCTS over graph** | AFlow（ICLR'25，MCTS over code-workflow，执行反馈回传、成本-效果 Pareto）；GPTSwarm（ICML'24，"agents as optimizable graphs"，边优化）；EvoOR-Agent（AOE 网络 + 图介导 path-conditioned 重组） | 搜索算子与成本-效果报告口径 | §C / §J.7 / §J.8 |
| **预算受限下的搜索策略** | **ExTS**（arXiv 2608.23848；在 AFlow 上验证） | 三机制：discriminative reward shaping / stochastic virtual child / **quality-conditioned branching** | §0.5-B / §J.7 |
| **代理模型跳过坏候选** | AgentSquare（ICLR'25，performance predictor 作 in-context surrogate） | 先打分、只真跑 top-K | §G.23 / §J.11（`GAP_PROBE_K` 已是此形状） |
| **shadow 转正 / 生长门 / 回滚的形式化** | **ATM**（arXiv 2607.20488） | 三条形式不变量：**capability monotonicity / state-routing completeness / shadow-before-live** | §0.5-C / §D / §J.5 / §J.6 |
| **质量多样性档案（防坍塌）** | YGN-SAGE（MAP-Elites 4D archive + CMA-ME）；ARES（NSGA-II 多目标） | MAP-Elites 式精英档案：按行为维度分桶、每桶留精英 | §0.5-A / §C / §J.8 |
| **子图结晶 = 结构化重构** | PSN（arXiv 2601.03509，structural refactoring + maturity-aware gating + rollback validation） | maturity-aware gating：成熟子图冻结、未成熟保持可塑 | §D（与惰性训练的 `wd` mask 合流） |
| **池生长 ↔ 拓扑共演化** | SkillGraph（arXiv 2604.17503，技能库与通信拓扑闭环共演化） | 能力表示回灌拓扑预测器（不只是输出维追加，**输入侧也要**） | §D 记账 / §G.6（gate 输入含新契约表示） |
| **路由选边的判据** | VOI budget control（arXiv 2605.05701） | value-of-information 作"下一个预算单位给谁"的判据 | §J.4 `route_obs`（作为**特征**，不替代学习） |
| **拓扑生成的 fallback 链** | YGN-SAGE（6 条路径优先级：检索 → 档案 → LLM 合成 → 变异 → MCTS → 模板兜底） | 优先级结构；`P3a` 的固定路由就是 template fallback | §F.4 P3a/P3b |
| **证据门控的生长 + 保留被拒** | Procedural Graphs（arXiv 2609.09153，"保留被拒编辑以防重复"） | 拒绝要进 manager 输入，防重复提案 | §I.1（`accept` 已记拒绝，补"拒绝进 manager 输入"） |
| **预算约束评测口径** | BCAS（arXiv 2603.08877）；EcoAgent-Bench（arXiv 2608.05519） | 预算作为任务的一部分；报经济一致性（$/task + 尾延迟） | §G.20 / §F.6 P5 步骤⑤ |
| **领域全景与分类** | 综述 *Self-Evolving Agents as Dynamic Graph Transformation*（arXiv 2608.18104） | 四类演化（节点/特征、边/拓扑、子图激活、跨组件共演化）作定位坐标 | §0.4 定位表述 |

### 0.2 本项目需要自创的部分（找不到先例）

1. **弱监督探针**：把**任务级验证从搜索中遮掉**、只留节点级 `post` 作搜索信号（`probe-real` 变体②）。
   检索未发现先例。**这条同时是论文贡献与产品必需**（生产域常无自动验证，见设计文档总览 §四）。
2. **闭集 append-only 契约池 + 有界文法 + 编译期类型检查**作为搜索空间。
   先例（ADAS）**明确反对**这条路，理由是代码空间能吃到 LLM 的代码先验、图空间搜索效率低。
   我们反过来选它，**换的是逐字节可重放与可审计**（`sig` / `compile_reject` / `EffectAudit` 全部可复算）。
   ⇒ 必须在报告里正面回答"用效率换可重放"这个取舍，并给出 `compile_reject_rate` 与搜索成本作代价证据。
3. **结晶 = 契约扩展**（子图折成新能力类，同时增专家、增 `action_head` 列、`H` 下降）。
   PSN 做"合并冗余技能"、ATM 做"拆分过载 agent"，都没有"折成新的**可寻址能力类**"这个动作。

### 0.3 与先例的差别（不是"更差/更好"，是"不同取舍"）

| 维度 | 先例常见做法 | 本项目 | 代价/收益 |
|---|---|---|---|
| 搜索空间 | 代码空间 / 开放模块空间（ADAS、AFlow、AgentSquare） | **闭集契约池 + 有界文法** | 表达力上限 ↓ / 可重放与可审计 ↑ |
| 改拓扑的时机 | 运行中 hot-swap（ATM、DyTopo、MetaGen） | **回合边界、离线、可 `set_active` 回滚** | 响应慢 / 安全与可回滚 ↑ |
| 改拓扑的粒度 | 角色/团队/通信边 | **能力类契约 + 节点实例 + 子图结晶** | 抽象层更高 / 需类型系统支撑 |
| 多样性保持 | MAP-Elites / NSGA-II（YGN-SAGE、ARES） | **本次补入**（§0.5-A） | 原设计只有 `Ei` 诊断、无机制干预 |
| 学习门控 | OracleStack 式"可训练裁决"（YGN-SAGE） | **四道入库闸 + 采纳闸** | 更严 / 成本更高 |

### 0.4 必须正面回应的反证

> **Rethinking the Value of Multi-Agent Workflow: A Strong Single-Agent Baseline**（arXiv 2601.12307）
> 结论：**单 agent 多轮对话 + KV cache 复用，打平同构多 agent 工作流，也打平 AFlow 优化出的异构工作流，且更便宜。**

这条**直接冲击主命题**（"编排有增益"）。它说明"单节点臂打平"不是可能发生的风险，而是**已被观察到的现象**。三条回应，全部要落进报告：

1. **任务域分族是承重结构**：`dev-hard` 四机制（超窗 / 高单步失败率 / 冲突约束 / 不可逆首步）保证**单次调用结构上不可解**。
   GA2 的 `SINGLE_CALL_MAX` 是这一族的**成立条件**，不是事后解释。若 `dev-hard` 上单节点臂仍打平 ⇒ 判负。
2. **该文的比较是同构多 agent**（同 base LLM，只差 prompt / tool / 位置）。
   本项目的池是**异构能力类**（不同工具、不同权限、不同确定性档、不同自治档），异构性由契约承载。
3. **该文未把预算作为约束**。本项目命题含**固定预算**：单 agent 多轮虽便宜，但预算耗尽即 `incomplete`；
   编排的价值可能体现在"同样预算下能做完更多"。⇒ P5 必须报 `$/task` 与 `P95` 延迟，否则这条回应无证据。

### 0.5 本次新增的三项机制（借用落地）

**A · 精英档案（MAP-Elites 式）**

- **新增 `elite_archive`**：按**行为维度**分桶，每桶保留该桶内的精英个体（`sig` + 结构 + 统计）。
  行为维度（住账本）：`|V|` 档 × 最大深度档 × `cost_exec` 档 × **契约多样性档**（不同 `contract_id` 数）。
- **与 `pareto_select` 的关系**：`pareto_select` 选"**当前代** Pareto 前沿"；档案选"**历史各行为桶**最优"。
  两者互补，**不可互相替代**——前者防被支配，后者防坍塌。
- **三个用途**：① **防坍塌**——EA/MCTS 的初始种群从档案采样，而非只从当前池；② **motif 表的来源**——
  档案里各桶精英的 `sub_sig` 就是"模型学到了什么结构"的实证；③ **升级诊断**——档案覆盖的行为桶数下降 = 探索退化。
- **门禁**：档案的**每桶精英必须进报告**（否则等于没做）；档案桶覆盖率进诊断列。
- 落点：§C 搜索 / §J.8 EA / §I.1 motif 报告。

**B · 质量门（ExTS 式，降搜索成本）**

- §J.7 `expand` 加**质量门**：仅当父节点分数足以支付扩展成本时才扩展
  （`score(parent) ≥ τ_gate · cost_estimate(expand)`），否则把预算转向**加深**已有高分链。
- 三个机制一起借：① **discriminative reward shaping**（分数分布窄时分离候选，用相对排名而非绝对值）；
  ② **stochastic virtual child**（从父节点奖励历史估计"新开分支"的价值，让扩展与加深竞争同一份预算）；
  ③ **quality-conditioned branching**（上述质量门）。
- **为什么必须借**：搜索是全实验最贵单项（每次 rollout 都真跑验收）。原设计是标准 PUCT + 无条件扩展，
  ExTS 的结论正是"无条件扩展在预算受限时分配很差：探索奖励在低访问数时占优、坏兄弟先被展开、分支与节点质量无关"。
- **风险（明写）**：质量门会降低覆盖 ⇒ `sig` 同构重复率与 `any_port_density` 可能恶化。
  ⇒ 这两个诊断线必须在报告里与 `τ_gate` 一起出列；恶化则回退（`τ_gate=0` 即原行为）。
- 落点：§J.7 / §G.21（`MCTS_ROLLOUT` 与 `τ_gate` 配套登记）。

**C · 三条形式不变量（ATM 式）**

把三条对齐到本项目已有的设计，并**形式化为可检查断言**（进门禁）：

| ATM 不变量 | 本项目对应 | 断言 |
|---|---|---|
| **capability monotonicity**（子 ⊆ 父） | 结晶不变量：`inputs/outputs/effects/refuses/publishes` 取并集 | 新契约的 `effects` ⊇ 子图并集；**不得**出现"结晶后能力变窄" |
| **state-routing completeness** | 子图 slot ↔ 外层端口的双向完整 | 子图内每个 slot 写入都有对应 `outputs` 端口；每个读都有对应入边或 `reads`；缺失即 `compile_reject(reason='crystallize_incomplete')` |
| **shadow-before-live** | 结晶实例的 `shadow=true` 期间不得进真实执行流 | 断言 `shadow` 实例在 `choose_instance` 中被排除；只有影子期达标才转正 |

- **与 ATM 的差别（明写）**：ATM 在**运行中的团队**上 hot-swap（需保持 `agent_id` / A2A 地址连续，因为上游调用方在看）；
  本项目在**回合边界**改池，**离线、可 `set_active` 回滚** ⇒ 更保守，**不需要** identity 保持机制。
- 落点：§D 结晶 / §J.5 `choose_instance` / §J.6。

---

## A · 实现基座（具体机制）

**确定性基础库**

- RNG 用 `mulberry32`；哈希用 `canonicalJson` + `crc32` / `hashObj`；**禁 `Math.random` 与内置 hash**。
- 规范序列化冻结；池版本 / 权重版本 / 图文法版本 / 提示词版本共用同一规范 hash 口径。
- 防漂移四门：前向逐位一致、往返一致、特征单源、规范序列化冻结（TS 运行时 ↔ Python 训练器一致性）。

**证据与存储**

- 门禁 harness：`inputs_hash` 绑定 `world/manifest/fixture`；**失败也落盘**；run 级 `manifest.json` 版本快照。
- 内容寻址 + 两级去重 + 全员版本化 manifest。
- 轨迹与「图-任务对」用稀疏 bin 格式入库，改造为「任务→图→结果」三元组。

**控制层与训练器**

- 白名单特征 + 指针式 Policy 前向 + f32 精确随机初始化 + `weights.json` arch 硬校验。
- `NODE_SLOT` 追加式稳定槽 + 变长 bitset + 图拓扑投影段（距 exit 距离 / outputs 消费关系）。
- Python 训练器：**F1–F4 四里程碑**——F1 数值梯度自检、F2 float32 执法、F3 arch fail-fast、F4 val 早停。

**真实模型端口**

- 配置源 = 项目根 `.env`（`base_url` + `model_id`，仅供测试；匿名免费档）；每 run 从清单选一个模型 pin 进 manifest，
  **run 内禁 fallback 换模型**；`model.kilo` 与 `model.replay` 同门（同请求 / 响应 schema）。
- IO 只在 `adapters/llm_gateway.ts`（core 零 IO）；teacher / 编码器 / manager 一律 `temperature=0`，按 prompt-hash 记忆化。

**验收与搜索**

- 验收器结构：通道收口 + verdict 指纹绑定（`pass:` + hash8）+ 对抗套件（静态错件 + fuzz）；
  验收对象 = 仓库状态 + 隐藏测试通过 + 测试文件哈希未变。
- 搜索器由有界 beam 改造为 MCTS / EA；搜索定位为**蒸馏目标来源**（expert iteration），不作运行时组成。
- llm teacher 产子目标分解 / 图候选 / 子图，**经验收器过滤后**才入蒸馏集。
- 跑批协议：网格 × seeds × **同预算** × 落报告；**不做 N-scaling 网格**（自变量是池版本/世代，不是数据量）。

**合成任务生成器**

- 两用：① **控制层预训场**（便宜、可解性可判、可产海量图-任务对）；② **CI canary**
  （真 LLM 进不了 CI，用合成任务测运行时 / 图文法 / 账本不变量）。

**明确不做**

- 冻结世界假设（全局 `world_version` bump、晋升即重算一切、作废旧数据）——本实验池版本**增量 append-only**。
- 固定图 + 单一指针策略；领域算子库；标量 `S(N)` scaling 协议。
- REINFORCE 只作对照、不作主路；其教训是「探索必须被引导」，不是「禁稀疏」。

### A.1 实验树布局

实验目录树见《总览》§五（设计口径，含 `weights/` 与 `runs/`）；实现按 §F 阶段顺序落各目录。
版本化产物约定：`weights/` 只增不改、可 `set_active` 回退；`runs/` 里被写进结论的 run 冻结只读；
`state/` 可重算、不进账本。

---

## B · 生成算法（受约束解码）

**输出序列**：图按**拓扑序**生成，全局约束在生成期即成立。

```
Graph    := ( NODE | LINK )* EXIT                 // 交错生成：边可紧跟其端点
NODE     := CAP <contract_idx> STOP               // 节点按生成顺序 = 拓扑序（只可连向 i<j）
LINK     := LINK <i> : <out_port> -> <j> : <in_port>
          | LINK <i> -> <j>                       // 省略端口 = 唯一匹配时自动补齐
                                                  // all/any 由 v 的输入端口在契约里声明，不由 token 决定
EXIT     := EXIT_STOP                             // 显式收口；末节点 outputs 即任务级验收候选
```

**为什么必须按拓扑序**：新节点 `j` 只允许连向**已生成的 `i < j`**，于是——
① **无环自动成立**（局部约束，mask 好写）；② **`entry` 可达自动成立**（除首节点外每节点至少一条入边）；
③ **`exit` 可达 O(1) 可判**（末节点收口）。**全局约束交给生成顺序，不在生成后校验**——这才是
"运行时只机械校验、不做语义兜底"能成立的前提。

**五条必须写死**

1. **端口编号**：契约端口按声明序 `0..k-1`，token 只出现编号（契约不可变 ⇒ 编号不漂移）。
2. **入边约束**：`required: true` 的输入端口**至少一条入边**，否则该节点不可生成；
   **入边度上限按 `binding_mode` 分开取**——`all` + `cardinality:1` ⇒ 1；`all` + `cardinality:'n'` ⇒ `1..MAX_FANIN`
   （`required:false` 时允许 0）；`any` ⇒ `1..MAX_ANY_CAND`（候选边可多条，`cardinality` 仍为 1、
   约束的是运行时注入数，见《契约与图》§二不变量 2）。
   **除首节点外每个节点至少一条入边**，由解码期 mask 强制（含"全部输入 `required:false`"的契约，见 §J.1 `allowed_cap`）。
3. **上限是 mask 不是事后拒绝**：`MAX_*` 在解码期逐 token 生效。
4. **图文法门禁变成"assert 解码器无漏洞"**（**语法层**：闭合、类型兼容、上限），而不是"过滤非法图"；
   真出现**语法**非法图即解码器 bug。**语义层拒绝**（同键 publish 偏序、汇聚类型不可满足）不在解码器职责内，
   走编译期静态检查，记 `compile_reject`、**不计入图文法门禁**，但必须报 `compile_reject_rate`
   （高 ⇒ 生成器没学会约束，是升级证据候选）。
5. **`EXIT_STOP` 的 mask 条件**：仅当图已**闭合**时才允许——闭合 = required 入边全连 ∧ 非首节点 ≥1 入边 ∧
   `all_reach_sink` ∧ `|V|≥1`（零节点图非法，空图上 `EXIT_STOP` **必须 mask**）。否则该 token 被 mask。
   **`BUDGET_STOP` 的补齐**与 `allowed_cap` 共用同一 `simulate_closure`（最小下标合法前驱 + 悬空节点向 sink 补出边），
   先闭合 required 入边再补 sink 可达；补齐消耗**计入本任务预算**，并逐次记 `greedy_completion`。
   **闭合预留**：`allowed_cap` 放行节点前必须 `simulate_closure(st+idx)` 成功且结果 `within MAX_EDGES/MAX_DEPTH`；
   **禁止**用 `max_depth+need` 这种把边数加到深度上的量纲混用。因此补齐**永不越过** `MAX_*`；
   若预留后仍无法闭合（只可能因预算耗尽），记 `incomplete`，**不得**产出未闭合图，**也不得**越过上限。
   语法层上限因此始终是硬 assert（见 §J.3），不再有"补齐越界"的例外。
   **省略端口的 `LINK i→j`**：按 §I.1「`role` 取值表与唯一匹配」的两阶段规则——先取**双方声明 `role` 且相等**的对（恰一对则用），否则在 **`role_ok` 兼容对**（双方声明须相等；单方/均未声明视为兼容）中恰一对才进入 mask；
   0 对不可行、>1 对必须显式端口。**禁止**按端口编号静默取首（与《契约与图》「运行时确定性优先序更不可取」对齐）。

**交错解码（与预算配合，缓解尾部偏置）**：`NODE`/`LINK` 交错采样，模型可显式吐 `EXIT_STOP` 提前收口；
预算触顶 ⇒ 吐 `BUDGET_STOP`，用**确定性贪心补齐**（取最小下标合法前驱）收口到 `exit`。
**不再"先采全部节点、再采全部边"**——那会让图尾部系统性退化为贪心结构。`EXIT_STOP` 与 `BUDGET_STOP`
都记 `decode_stop_kind` 入轨迹。**每次 rollout 产出的是"闭合图"（所有 required 入边已连）**；
预算不足以闭合时记 `incomplete`，不得产出未闭合图。

**不可行入边的处理（必须写死，否则解码器不定 ⇒ 不可复现）**：

- **(a) 采样到的边不可行**（模型选的前驱/端口不满足类型兼容，但**存在**兼容前驱）：**不重采、不计图文法门禁**，
  回退贪心——取**最小下标、类型兼容**的前驱补齐，记 `decode_fallback(kind=infeasible_sample)`。
- **(b) 该 `required:true` 输入确实无类型兼容前驱**：非首节点 ⇒ 该 `contract_idx` 在**解码期被 mask**
  （不允许在此生成），记 `decode_fallback(kind=no_compatible_predecessor)`；首节点 ⇒ required 输入只能由
  `entry` 的 typed 供给满足，`entry` 供给里无兼容项同样 mask。**若 mask 后无合法节点 ⇒ 池不变量或解码器被破坏：
  门禁直接判红**，**不得**回退成空图、也不得静默 `EXIT`（零节点图非法）。重采会破坏确定性；判非法会混淆
  "解码器 bug"与"采样撞墙"；**回退空图会把 bug 伪装成合法 rollout**。`decode_fallback` 带 `kind` 进轨迹与诊断列
  （`no_legal_node` 作为**断言失败**入账，不是正常回退路径）。

**贪心补齐的偏置与公平性**：贪心补齐系统性让"图尾部 = 贪心结构、非模型意图"，关键节点若落尾部会被破坏。
**交错解码已大幅降低但未消除该偏置**——预算触顶时仍走贪心补齐。因此：① 所有生成臂
（自适应 / 随机合法图 / 无搜索纯生成）**共用同一补齐策略**，否则对照不公平；② 每臂必报
`greedy_completion_rate`（按边：被补齐边 / 全部边），高 ⇒ 编排学不会预算感知或 `MAX_*` 上限过紧，是升级证据候选。

**OR 分支密度（路由有落点的前提）**：路由贡献只在 `any` 端口（OR 分支）上体现；生成器须保证产出图有**非平凡 OR 分支密度**（`any_port_density`），否则路由结构上 ≈ 0、GA8⑦"同图随机路由臂"测不出。低密度记诊断、作升级证据候选。

---

## C · 搜索与蒸馏算法

**MCTS 口径（照此实现）**：`state` = 部分拓扑（受约束解码前缀）；动作**分两层**（先选 motif / 契约，
再选端口），减少昂贵验收次数；**motif** = 池内既有子拓扑片段（含结晶出的单节点、以及反复出现的
"分解→生成→校验"子图），按 `sig` 规范化后建库；`expand` 只展开过闸的合法扩展；选择用 **PUCT**，
先验 = 当前编排策略（**评估臂可关先验以保持"不依赖未训策略"的对照**），`value` = 验收通过 + 成本惩罚 +
学到的 value head；`rollout` 兜底仍是**确定性贪心补齐**到 `exit`；`backup` 用访问均值；**transposition table 用
部分拓扑前缀的规范键** `prefix_sig(st) = H(canonicalize_prefix(st))`（节点按首次生成序重标号、边按 `(i,out,j,in)`
排序，只含已生成前缀；整图 `sig` 只用于最终去重）；预算 = 展开次数 + 控制层 token，
**记 `ROUND_B`，不摊进 `cost_exec(G)`**。

**`value head`**：编排模型的辅助输出头（与 gate 辅助损失同档），参数量与 MDL 计入编排模型，
训练信号 = 验收通过 + 成本惩罚；不单列模型、不单列预算、不进模型清单。

**EA 口径**：变异算子白名单（插入 / 删除 / 同契约替换 / 边重定向 / 加 skip / 分支 / 合流 / early-exit），
交叉只在同 **`family_sig`**（节点/契约多重集）内，等价结构按 `sig` 去重。

**路由口径（写死）**：any 端口选边的主监督 = 搜索 / teacher 轨迹中该端口的选边（与编排同源的 expert iteration，
**不用 REINFORCE 作主路**）；辅助信号 = 被选中节点的 `post` verdict + 局部成败（step 级标签、回合末离线更新；
执行期权重冻结，禁止执行期 SGD）。选边记 `edge_choice`，与 `post` 以 `(task_id, step, node_index)` join。
**拉式惰性**：路由在候选**求值之前**选边，obs 只含已产出 slot 摘要 / 已执行能力集 / 剩余预算 / 候选边静态特征；
未被选中的分支记 `branch_not_taken`（0 计费）。同一 `any` 端口在一次执行内只选一次，不重选。

**蒸馏目标**：软目标按优先级取一——① visit 分布（首选）；② 帕累托采样（visit 不可得时的退化档）；
③ 单解任务退化为普通 CE。损失 = 集合级 softmax（listwise）。**变长图口径（写死）**：`s(g)=(1/|tokens(g)|)·log p_θ(g)`，`q(g)∝exp(s(g)/τ)`；**不归一会造成小图偏置**，**不加成本 / 复杂度权重**。
**禁止** `1/(成本×复杂度)` 全集合加权、均匀软标签、只取搜索到的第一个解。
必须报"蒸馏目标 `|V|` 分布 vs 搜索产出 `|V|` 分布"。

**退化监控**：报 `H(π_policy)`、`H(π_search)`（按 `family_sig` 分桶归一化后的香农熵，bits）与
`Ei = D_KL(π_policy ‖ π_search)`（bits）；**共退判据 = `Ei` 与 `H(π_policy)` 同向单调下降**。
公式若调整须登记。

**惰性训练**：只训被激活的能力类专家与受影响节点；触发条件与预算由外环登记。新能力类 = 新专家零初始化槽，
旧专家权重不动。

### C.1 控制层实现规格（MoE / gate / 迁移）

- **gate 粒度（写死）**：gate **按生成位置运行**，输入 = `子目标编码 + 当前部分拓扑特征`，每位置输出 top-k 专家；
  **不是按子目标只 gate 一次**——否则多契约图无法生成，且位置级辅助损失无对齐点。
- **gate 追加式扩展**：gate 输出维度随专家数变化 ⇒ 旧 gate 列原样保留、新专家列零初始化，训练时**冻结旧列**；
  整表重训只允许在「控制层容量」档中作为一次独立实验，并登记预期。
- **gate 输入侧也要跟池生长（借自 SkillGraph，§0.1；原设计只做了输出侧）**：
  原设计只把新专家加到 gate 的**输出**维度；但 `gate 输入 = 子目标编码 + 当前部分拓扑特征`，
  其中"已生成契约"这类特征必须**编码契约身份**——若该编码是固定维度的 one-hot / 固定表，
  新契约就落不进输入侧 ⇒ gate 无法区分"新契约"与"未知契约"，追加的输出列永远学不出正确路由。
  落法：**契约身份输入 = 按 `contract_id` 索引的 append-only embedding 行**（与输出列同源、同一次追加），
  新契约 = 新行零初始化；`arch` 的 fail-fast 检查必须含该表的行数与池版本一致。
- **权重迁移与防遗忘**：arch bump 时旧专家权重按专家 id 保持可加载、新专家独立零初始化；重训只在"被激活专家 +
  受影响节点"上做。每次 arch bump 必须过"旧权重可加载 + 旧金丝雀不回退"的迁移门禁，否则回退旧 `ver`。
- **gate 信用分配辅助损失**：蒸馏主损失是整图 listwise softmax，传到每个位置的 gate 决策时信用分配弱。
  加节点级辅助损失：位置 j 的 gate 选的 top-k 专家 ≠ 搜索器在该位置选的契约 ⇒ CE 惩罚，作为序列主损失的辅助项。
  辅助损失权重进版本并计入 MDL。
- **编码器计费（两级）**：① 任务/子目标自由文本走固定 LLM 编码器，调用成本计入本任务 `B`（不得剥离出 cap）；
  同一任务全程只真正编码一次（缓存），但**每臂每任务按同一 `encoder_cost` 名义等额计费**，使对外四维 `used_ext`
  跨臂可比。**名义 `encoder_cost` = 该 `encoder_pin` 下该任务首次真实编码的 `calls`(=1)/`tokens`**（`temperature=0` + prompt-hash memo ⇒ 确定、可复算）；`walltime` 取首次实测值单列 `encoder_walltime`（受 §G.1 walltime 口径约束、不进结论等价硬约束），缓存命中臂按此名义等额计费。② 逐节点 obs 走确定性白名单特征，不进 LLM 编码器、无额外调用成本。`encoder_cost` 单列、
  **不并入 `cost_exec`**，但**计入 `used_ext`**。逐节点 LLM 编码为后置升级档。`encoder_pin` 进 arch fail-fast。

### C.2 搜索 / 蒸馏实现细则（已写死；见 §J.7 / §J.8 / §J.13 / §J.16）

- motif 库索引键 = `sub_sig`；检索 = 当前 frontier 的 `boundary_inputs` 与 motif `boundary_inputs` 类型兼容，再按 `sub_sig` 去重。motif 是完整诱导子图，**不是** `prefix_sig` 同构；`prefix_sig` 只作 MCTS transposition table 键。
- value head 输入 = 与编排共享的部分拓扑特征（已生成契约多重集、未闭合 required 端口、`|V|/|E|`、剩余预算三维）+ 标量；归一化与编排 head 同一白名单，禁止另开特征源。
- **EA 交叉** = 同 `family_sig` 下的**规范对齐边集切割**（§J.8）：节点多重集已相同，交叉只重组边；切割点由搜索 RNG 抽；子代经 `simulate_closure` + `valid`，失败丢弃并记 `invalid_crossover_rate`。不采用「子图块交换 / 诱导置换」——在 `family_sig` 已对齐时它们是边集切割的特例，再开一套算子只会双计丢弃率。
- **帕累托维** = `{pass@1 ↑, cost_exec ↓, H ↓}`（三维，非支配；`cost_exec` 不含 walltime）。`pareto_select` 按前沿层填满 `EA_POP`，层内按拥挤距离再 `sig` 字典序（确定性）。
- **THINK 监督**（§J.16）：THINK 词表 = `{THINK, THINK_STOP}`（一元计算步，**不**含契约/motif，否则违反「THINK 不产节点」）；PV 动作与 value 走 **readout 头**，不是 THINK token 本身。gate 辅助损失仍只按 `NODE` 位置计。

---

## D · 结晶契约合成规则

**触发**：同一 `sub_sig` 子拓扑在 ≥ `k` 个 dev 任务上**任务级验收通过**（`sub_sig` 见 §I.1，非整图 `sig`；`sig` 用于整图去重、`family_sig` 用于交叉域，三者不可混） ⇒ 结晶为单节点。

**合成算法（从子拓扑归纳，署名 `agent/manager`）**：

- `inputs` = 子图入口对外部输入的映射；`outputs` = 子图 `exit` 的输出位。
- `reads` 边界闭合：取子图各节点 `reads` 的并集，**减去**「由子图内部 publish、且该读取点在内部发布之后」的键；
  在内部首次发布**之前**被读的键必须保留。
- `publishes` = 子图内所有 `publishes` 键的并集（对外暴露最终版本，与《契约与图》§2.2 状态规则 5 的偏序合并一致）。
- `pre` = 子图所有入口前置的合取；阈值参数仍走 `put(slot='threshold')` 回合锚。**不得**写成任务级验收式。
- `refuses` = 各节点合法拒绝码的并集；`effects` = 各节点 `effects` 的并集（取并集不取子集；按 `touches_effects` / `can_delegate` 两轴，不用已废除的 `pure/effect/agent`）。
- `post` = 所有活动路径都执行的节点（AND 骨架 + sink）的过程 post 合取；仅存在于部分 OR 分支上的 post **不进入**结晶契约。**不得**写成任务级验收式。
- `cost` = 各节点实例 `cost_model`（缺省回退契约 `cost`）沿**最长路径**的聚合上界。
- `idempotent` = 所有节点**生效档位**为 `exact` 时为 true，否则 false。
- `touches_effects` = 子图内任一节点为 true；`can_delegate` = 子图内任一节点为 true；`determinism` = 各节点**生效档位**中的**较弱者**（`exact ≻ audited`，任一 `audited` ⇒ `audited`）。
- `role_tag` 由 manager 提案给出，走 `declare{kind:'role'}` 进 append-only 枚举。
- `delegate_reads` = 各节点 `delegate_reads` 的并集 ∩ 新契约 `reads`。

**实例侧（原文缺，缺了结晶无执行载体）**：同时产出一个 `implementation:'composite'` 的 `NodeDecl`，
`bindings.subgraph` = 被折叠子拓扑的 def pin。子图内部**逐节点照常执行、照常按实测 `EffRequest` 计费**，
外层只见一个节点。故结晶降的是外层 `H`，**不降** `cost_exec`（《契约与图》§一「结晶的收益边界」）。
`depth_equiv` = 子图深度，计入外层 `MAX_DEPTH`。

**记账**：结晶 = 契约扩展 + 新实例，必然触发 专家追加 + gate 追加式扩展 + `action_head` 列追加 + arch bump + 重训 + 门禁重跑。
账本写三条 `declare` + 一对采纳：`declare{kind:'capability'}` → `declare{kind:'node'}`（`composite` 实例，
`body.crystallized_from = { sub_sig, source_graph_sig, evidence_id }`）→ `declare{kind:'motif'}` → `add_ver` + `accept`。
**不设专用 `crystallize` op**——来源子图记在 `declare{kind:'node'}` 的 `crystallized_from` 里，
"独立新增契约"与"结晶产生的契约"依然可区分，`«结晶使 H 下降»` 仍可审计。

---

## E · 门禁清单（全部脚本化，证据落 `runs/gates-<stamp>/`）

| # | 门禁 | 判据 | 失败后果 |
|---|---|---|---|
| GA0 | 隔离与唯一写口 | 运行时/训练器不互相 import；账本只经唯一写口；非测试代码无外部依赖 | 测试即红 |
| GA1 | 图文法 | **语法层**：生成拓扑 100% 闭合（required 全连 ∧ 非首节点 ≥1 入边 ∧ all_reach_sink ∧ |V|≥1）、类型兼容、上限内、**`sink` 唯一**（无第二个零出度节点）；语法非法图数 = 0（出现即解码器 bug）。**`decode_fallback(kind=no_legal_node\|no_compatible_predecessor)` 与 `assert` 失败一律判红**（它们是断言失败，不是回退路径）。语义层拒绝（同键 publish 偏序、缺 join、汇聚类型不可满足、entry 歧义）记 `compile_reject`，**不计入 GA1**，但必报 `compile_reject_rate`（分 reason 出列；`publish_order` 占比 > 0.05 记诊断） | 回合作废 |
| GA2 | 可解性 | 用 **oracle 臂**（**默认最强模型 + 长预算 + 允许多次调用**；人类补丁仅当池规模小到可负担时可选，本实验 `N_dev=960`、人类补丁不可负担，故不用；独立于任何对照臂）在 **dev 上**判定可解比例 ≥ `SOLVABLE_MIN`（默认 0.80）；**`dev-lib` 与 `dev-hard` 两族分别达标**（合并达标不算——否则 `dev-hard` 可以靠 `dev-lib` 拉高，"不可解"被误读成"编排无效"）。**oracle 产物只用于可解性测量与难度度量 `f_*`，不得作为蒸馏目标入训练集**。**不用固定图臂**——它会低估可解域并掩盖任务缺陷。**同时报 under-`B` 可解比例**作 `S@B` 的可见天花板。**另报单次调用可解率**（1 次调用、同 cap）：`dev-lib` 上应较高（它是基线族），`dev-hard` 上须 ≤ `SINGLE_CALL_MAX`（默认 0.35），否则该族不成立、模板回炉 | 测试即红 |
| GA3 | 抗投喂 / 拒绝比 | 节点级验收器对错误产物拒绝比 = 1.0、正确产物喂饱比 = 1.0；**全拒臂 == 0** | 测试即红 |
| GA4 | 测试完整性 | 评测测试文件哈希 == 钉死哈希 | 任务分 0 |
| GA5 | 泄漏与 holdout 纯洁 | 任务哈希与 `expected` 不出现在上下文 / 提示词 / 参数 / 记忆（含 JSON 内嵌）；**且搜索器与 teacher 从未在 holdout 上运行、蒸馏集不含任何 holdout 任务的拓扑** | 提案拒 |
| GA6 | 预算账 | 每任务/每臂同预算；限速/超时/失败**单列**，不得计入能力失败。**判据改为成本事件流对账**（《契约与图》§2.2）：① `attributed_to` 构成划分（每条事件恰一类、无未分类事件）② 各派生视图之和减去已声明重叠 == 事件流总量 ③ `attributed_to='search'` 的事件在 `cost_exec` 视图里为 0 条 ④ `attributed_to='ratelimit_wait'` 的事件 `counts_against_cap` 恒 false ⑤ 每条 `graph_exec` 事件可 join 到一条 `audit`。**不再靠人工核对九个口径** | 该 run 作废 |
| GA7 | 双集门槛 | **配对单位 = 独立簇**（`template_id, k_files, defect_site`；簇内换名副本先聚合，见 §I.2）。目标命题（vs `fixedgraph`）用 `Δ`：**簇级配对差值单侧 CI 下限 ≥ Δ**（BCa 自助，**BH-FDR 校正族 A = 分层归因各档**：难度/契约/自治分桶）；采纳闸（vs `incumbent`）用**配对非劣检验**（dev 簇级配对差值单侧 CI 下限 ≥ −δ 且实测半宽 ≤ δ，**簇数** `n ≥ max(200, 功效分析所需)` 为前置；**同一 `incumbent` 窗口内的重复检验须用预注册 group-sequential / alpha-spending 控整体 type-I，窗口的最大回合数与每轮 α 在窗口开始时登记；`incumbent` 变更 ⇒ 窗口清零重开**）且（**检查点回合**）`S_new(holdout) ≥ S_inc(holdout)−ε`。**断言窗口内 dev 批按簇不重复**（否则 n 攒不够、信息累积前提不成立） | 不采纳 |
| GA8 | 证伪臂 | ① **单节点主档臂**（"编排无用"；**同一 pin 模型**、强 variant、单节点，不换模型）② 人工固定图臂 ③ 随机合法图臂（**其 pass@1 不得高于 `floor`**）④ 全拒臂 ⑤ 无搜索纯生成臂 ⑥ **节点多重集相同、仅拓扑打乱**的安慰剂臂 ⑦ **同图随机路由**臂 ⑧ **固定分解（teacher 单次产出）+ 搜拓扑**臂 ⑨ **冻结编码器 + 随机编排**臂 ⑩ **自治档位臂**（**pin 一张 reference 子图拓扑**，三档都跑**同一张已 pin 子图**、只差自治档：**L0** = 该子图以 `composite` 实例内联执行（无重试、无委派）、**L1** = 同一 `composite` 实例 + `retry_policy`（K>1）、**L2** = 一个 `can_delegate:true` 节点委派**同一张已 pin 子图**（`delegate` 时不重新 decode、直接取 pin 住的 `sub`，见 §J.12 的 `pinned_sub` 旁路）；三档**强制指定实例**（走 harness、不走 `choose_instance`），否则档位与实例健康分混淆。同 seed 重生成不能保证同构，会把拓扑方差混进自治消融）⑪ **池冻结臂**（同课程同预算、禁用结晶与契约扩展；P4 后，跨世代 lineage 级对照）⑫ **执行节点推理档位臂**（同图同任务、只改节点 reasoning variant；**P3a 后**——只依赖"有一张 pin 住的图"与节点绑定，不依赖控制层）⑬ **控制层关思考臂**（同权重同容量、`MAX_THINK=0`；**P3c 后**——依赖 `THINK` 已落地）——全部同 cap、同 holdout；**除"异模型对照位"与⑫推理档位对照位外，所有臂必须 pin 同一模型 / 解码 / 绑定**。**GA8① 不豁免**：它测的是"编排 vs 单次调用"，不是"模型大小"。**GA8① 必须按族分栏报**（`dev-lib` 打平是预期、`dev-hard` 打平才判负，见 §E 表后说明） | 结论不成立 |
| GA9 | 可重放 / 可回退 | 回灌下逐字节等价；任一变更可回退并复现旧结果 | 测试即红 |
| GA10 | 生长不变量 | 新节点不改可寻址面；`NODE_SLOT` 追加式；旧专家/旧权重在新池版本下仍可加载 | 测试即红 |
| GA11 | 漂移 | **每实例**金丝雀滚动统计（按契约定义的集合）在界内；超界即记账。检测默认 **CUSUM 双侧**（阈值按目标 ARL 预注册；`target` = 转正时 pin 住的基线，**不用滚动均值**——否则缓慢漂移会被 target 跟着漂、永不触发）；**下降侧 ⇒ `quarantine` 降级；上升侧 ⇒ 强制重测金丝雀 + 重置基线（不降级）**，两者都写 defs 链。**SPRT 不得并行**。不用固定 n=20 的 Wilson 下界。`pending` 金丝雀不进检测。provider / model id 变更 ⇒ 重测并 reset CUSUM 状态、记 `note` | 实例降级 |
| GA12 | 状态隔离与共享 | 越界读写拒绝；诱饵字段下输出逐字节不变；**同一 `shared` 多节点都读得到**；重复执行同 artifact；**memo 键含 `task_id`，跨任务同键不得命中**；读写集与发布事件可从轨迹重建；**工作区按 `(task_id, arm, seed, attempt)` 全新实例化并在结束后整目录删除，禁跨臂复用**（断言两臂对同一任务的工作区路径不同且互不可见）；**同键 publish 是追加版本、旧版本仍可由 `pins` 解析到** | 测试即红 |
| GA13 | 防冗余 | 幂等节点同键不重复计费（**memo 只适用 `trainable` / 无端口 `tool` / 全 `exact` 的 `composite`；`llm` 节点一律不可 memo**，断言 `llm` 节点无 `memo_hit`）；`redundant_step_rate ≤ 0.10`（含执行前 `redundant_reject` + 执行后 `wasted_step`）；`wasted_budget_rate ≤ 0.20`（**只含** `wasted_step` 实测消耗 / 已执行总消耗；`redundant_reject` 不计费、不进该比率；DAG 下 `wasted_step` 只来自 L1 重试与 `composite` 内部，故该比率实质是 **L1 空转率**）；同 slot 单写者；扇出必须走声明式聚合；**OR 分支必须真省预算**（断言 `branch_not_taken` 节点的实测消耗 = 0） | 该步拒绝 / 记退化 |
| GA14 | 沙箱与 `exec` 隔离 | `exec` 只在工作区白名单、默认无网、超时、资源上限；产物路径回写校验；越权/逃逸即拒 | 任务分 0 |

**GA8 是这套实验的证伪闸**：若单节点主档臂打平，整个"编排有增益"的命题当场塌。
**GA8① 必须按族分开报**：`dev-lib` 上单节点臂接近自适应臂是**预期的**（该族本就单次可解，它是对照基线）；
只有在 `dev-hard` 上单节点臂仍打平，才构成对命题的证伪。把两族混报会让基线族的"打平"淹没不可解族的信号——
这是原设计最大的隐性风险（任务域按"便宜可判分"选，不是按"需要编排"选）。
**`SINGLE_CALL_MAX=0.35`（住账本）**是 `dev-hard` 族的成立条件，由 GA2 在入池时把关，不是事后解释。

---

## F · 阶段计划（每阶段可独立验收）

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0** | 账本 + 版本 pin + rng/hash + 合成任务 canary + bench 规格 | 账本链可校验、canary 全绿、同输入重跑逐字节一致 |
| **P1** | 图文法 + 节点池声明 + 运行时解析执行（**真 LLM 端口按主档接入，执行体不再强制全桩**）+ `model.replay` 桩 + **replay 同门门禁（最小版）** + 自治 L1 | GA1 / GA3 / GA10；真 LLM 与 replay 同门下跑通一张生成图；`compile_reject_rate` / `greedy_completion_rate` / `any_port_density` 出列 |
| **P2** | replay 同门门禁**全量覆盖 bench**（`model.kilo` ↔ `model.replay`）+ 编码 bench（dev/holdout）+ 单任务真测试闭环 | GA2 / GA4 / GA5 / GA6 / GA14；单任务真跑真测试通过并留审计 |
| **P3a** | **只上编排模型**（TS 前向 + Python 训练）+ 数据飞轮（三层数据 + 四道入库闸）+ 离线搜索蒸馏（MCTS/EA）+ **固定分解**（teacher 单次产出，全臂共用）+ **固定路由**（`any` 端口按确定性规则选首个候选，不训） | F1–F4；蒸馏后同任务 pass@1 提升；飞轮四项可观测指标出列。**这是最干净的起步配置**：只有一个可训模型、一个自变量 |
| **P3b** | 加**路由模型**（`any` 端口选边 + step 级 dense 标签 + 回合末离线更新）+ **自治 L2 子图委派** | GA8⑦「同图随机路由」臂可归因出列（前提：`any_port_density` 达标）；子图预算切分正确 |
| **P3c** | 加**分解模型**（蒸馏分解、含再分解）+ **控制层内思考（`THINK`）** + **MoE/gate**（若 P3a–P3b 出现容量诊断则上，否则保持契约 embedding 档） | GA8⑧「固定分解」臂与⑬「关思考」臂可归因出列；`gate_k_shrink` 出列 |
| **P4** | 进化外环：监控指标层 + manager、漂移、结晶、生长额度、双集门槛、回退 | GA7 / GA8 / GA11；**先让它红**（非法 / 无证据 / 无增益 / 超额生长提案必须被拒） |

> **阶段门与 `ESC_ROUNDS` 的关系（P3 分段后需重申）**：升级阶梯的「阶段门」通道按 **P3a / P3b / P3c 各自验收**
> 解锁下一段，不是「P3 整体全绿」。`ESC_ROUNDS` 的失败驱动通道只在**已进入训练回合的段**内计数
> （P3a 起）；段间切换不重置 `ESC_ROUNDS`，但**新段引入的部件不算"上升一档"**（它们是计划内交付，不是阶梯项）。
| **P5** | 报告与归因：全臂同预算对照（结论网格 13 臂）+ 五自变量分解 + 如实红 | 报告落 `runs/`；待决登记回填 |
| **P6** | **产品化桥**：账本与运行时迁内核、真实插件池接入、多 agent 角色分离（触发式） | 迁移清单里"需生产重验"的条目全部有结论；**不是**复现实验结论（生产域任务不同，既不可能也不必要） |

**P0–P2 的 CI 路径可回放到 stub**：真 LLM 自 P1 起即可接入，但门禁与回归必须能回放到 stub；
`model.kilo` 与 `model.replay` 必须同门——否则门禁不可重跑。

### F.1 P0 — 账本与确定性基座

- **交付**：`experiment/ChronoGraphLab/` 骨架；账本（`Entry` 链式哈希 + defs/events 两条 append-only 日志 +
  `worldRev` 摘要）；版本 pin；确定性基础库；合成任务生成器最小版 + canary；bench 规格。
- **步骤**：
  ① 按《总览》§五建实验树 + `package.json` / `vitest.config`（`weights/` 只增不改、`runs/` 结论只读、`state/` 不进账本）；
  ② `Entry` 字段 + op 枚举 + `argsHash=H(args)` + `entryHash=H({at,seq,prev,op,argsHash,by,ref})` 链校验；
  ③ defs/events 双链分写、`worldRev=H({defs 键集, ids 摘要})`、`snapshot`；
  ④ `mulberry32` / `canonicalJson` / `crc32` / `hashObj` + lint 禁 `Math.random` 与内置 hash；
  ⑤ trace 一等事件 schema 落地（§I.1 字段级，含 `wasted_step` / `input_request` / `edge_choice`）；
  ⑥ Evidence / Proposal schema 占位（缺 `evidence_id` 的提案拒）；
  ⑦ 合成任务生成器最小版 + canary 套件（尚无冻结池，只测不变量）。
- **验收**：账本链可校验、canary 全绿、同输入重跑逐字节一致；`incomplete` 可记录。

### F.2 P1 — 图文法 + 节点池 + 运行时解析执行（L1）

- **交付**：`Contract` / `NodeDecl` 声明解析；受约束解码器（§B）；编译期静态检查；活动子图 executor；
  `model.kilo` 真 LLM 端口 + `model.replay` 桩 + **replay 同门门禁（最小版）**；自治 L1。
- **步骤**：
  ① `Contract` / `NodeDecl` 解析（含 `delegate_reads ⊆ reads`、`canary_set` 在契约上、health 不进 NodeDecl、
     `cost` 四维先验、`role_tag`、`reads[].optional`、**`post` 判定输入面校验**、
     **三元组生效档位解析**（`llm ⇒ audited/idempotent:false`、非确定工具判据）、`composite` 载体与子图聚合校验、
     **`refuses` 只能引用全局 `RefusalCode` 表**（自造码即拒——否则跨契约失败聚类不成立，见《契约与图》铁律 4））；
  ② 池不变量：artifact 兜底首节点 + `join` 契约 + 无输入端口仅首位 + `confidence` 旁路位不进数据流；
  ③ 解码器（§J.1）：THINK 前缀、逐 token mask（含 `MAX_ANY_CAND` / `MAX_FANIN` 分开取、`role_ok` 两阶段、禁重复边）、
     唯一匹配 LINK、`simulate_closure` 预留、空图禁 EXIT、`NO_LEGAL_TOKEN` 分支、`decode_fallback`；
  ④ 贪心补齐（§J.2）：entry 虚拟边、sink 可达、与 `allowed_cap` 同一选择规则、确定性遍历序；
  ⑤ 编译期检查（§J.3）：语法层 assert（含 `sink` 唯一）vs `compile_reject{publish_order, merge_type, missing_join, entry_ambiguous}`、
     **互斥 OR 分支的静态判据**（保守：判不出即视为可同时命中）；
  ⑥ executor（§J.4）：**拉式惰性 `demand` 递归**、`any` 端口选边在前求值在后、`branch_not_taken` 0 计费、
     slot 按 `(node_index, out_port)`、`publish_append` 版本序列、实测 EffRequest 计费与 cap 拒发收口、
     `redundant_reject` / `wasted_step` 两段（后者只在 L1 重试与 composite 内部）；
  ⑦ `choose_instance`（§J.5）字典序 + 影子下界；A/B 由 harness 强制；
  ⑧ L1 有界循环（§J.15）+ `request_input` 协议（只取 `optional` reads、不触发新前驱求值）；
  ⑨ `model.kilo` + `model.replay` 同门最小版；**工作区按 `(task_id, arm, seed, attempt)` 建/删**。
- **验收**：GA1 / GA3 / GA10 / GA12（隔离与工作区部分）；真 LLM 与 replay 同门下跑通一张生成图；
  `compile_reject_rate`（分 reason） / `greedy_completion_rate`（按边） / `any_port_density` / `branch_not_taken 比例` 出列；
  **断言 `llm` 节点无 `memo_hit`、`branch_not_taken` 节点消耗 = 0**。

### F.3 P2 — replay 同门 + 编码 bench + 单任务真测试闭环

- **交付**：replay 同门门禁**全量覆盖 bench**；dev / holdout 模板族；沙箱最小版与 `exec` 端口；任务级验收器；
  GA2 / GA4 / GA5 / GA6 / GA14 脚本。
- **步骤**：
  ① 按 §I.2 目录生成**四族**：`dev-lib` 20×32 + **`dev-hard` 10×32**（A 超窗 / B 高失败率 / C 冲突约束 / D 不可逆首步 各 2–3 模板）
     + `hold-pipe` 10×32 + **`hold-hard` 6×32**，参数轴统一 `k_files`4 × `defect_site`4 × `rename_seed`2；
     **断言独立簇数 `C_dev=480`（320+160）/ `C_hold=256`（160+96）**；构造 oracle = 逆补丁；
     **另生成 `probe-real` 6×8 = 48 任务**（真实开源 TS PR 反向构造；独立于上面四族，**不进规模核算**）；
     **同时造"真实感契约池"**（带真实提示词/工具绑定/错误模式的契约，≤ 32；探针与变体②共用）；
     `f_*` **六维**校准（按 `(template, k_files, defect_site)` 声明区间逐簇判；`f_ctx` 需先 pin `CTX_BUDGET`）
     + `theta.ast_sim` 族间扫描（报余弦分布，贴线通过即重设计骨架）；
     **`dev-hard` 额外两关**：oracle 可解率 ≥ `SOLVABLE_MIN`（该族单独算）且**单次调用可解率 ≤ `SINGLE_CALL_MAX=0.35`**，
     任一不过 ⇒ 该模板回炉（前者说明任务无解、后者说明它其实单次可解、不属该族）；
  ② 沙箱：工作区 realpath 白名单（win32 reparse/junction + TOCTOU 二次校验）/ 超时 / 默认无网 / 产物路径回写；
  ③ 任务级验收器：`hidden_test_cmd` 全过 ⇒ `pass@1=1`；**做题** walltime 触顶/预算触顶 ⇒ `incomplete`（验收照跑）；**判卷**超时 ⇒ `pass@1=0` 且记 `verify_timeout`（不记 `incomplete`）；测试文件哈希钉死；
  ④ 入池五检：start_commit 必红 / **构造 oracle** 必绿 / 哈希钉死 / 路径⊆白名单 / 难度落档；
  ⑤ **能力 oracle**（最强模型+长预算）写 `runs/oracle-<stamp>/` 只读，不进蒸馏；测 `SOLVABLE_MIN`；
  ⑥ pin 冻结池 + 断言 `N_dev=960`/`N_hold=512`/`C_dev=480`/`C_hold=256` + 回填 `s`、锚点终值与 `CTX_BUDGET`；
     钉死 `DEV_VAL_N=64`（**= 32 个完整簇、两族各半，不切开簇**）；**沙箱镜像 pin**（含 `node_modules` 与 vitest 版本，`hidden_test_cmd` 不用 `npx`）；
     **同时 pin GA8② 人工固定图臂的拓扑与 `|V_seed|`**（`H(G)` 的分母，P3a 起就要用；原表只在 P5 引用它 ⇒ P3a 时无值）。
     人工固定图 = 人类按两族任务手写的**两套**固定编排（基线族一套、不可解族一套），两套的 `|V|` 都记入 manifest，
     `H(G)` 按当前任务所属族取对应 `|V_seed|`；
  ⑦ 每契约 pin canary 反向切片（§J.14）+ 类型兼容的 20 任务分层抽样；pin 前 `pending`；
  ⑧ replay 同门覆盖全量 bench。
- **验收**：单任务真跑真测试通过并留审计；oracle 可解比例 ≥ `SOLVABLE_MIN`；核算式与校准门禁全绿。

### F.4 P3 — 控制层（分三段：P3a 编排 → P3b 路由+L2 → P3c 分解+思考）

> **为什么分段**：原 P3 把三模型 + 编码器 + teacher + manager 一次性上齐，同时引入 5 个可变部件。
> 一旦 pass@1 不动，无法判断是编排没学会、路由乱选、分解切错、还是 gate 坍塌。分段后每段只加一个自变量，
> 失败定位是构造性的。**代价**：阶段数从 7 变 9，`ESC_ROUNDS` 的阶段门要相应改为按 P3a/P3b/P3c 各自验收。
> **P3a 已是完整可跑系统**（固定分解 + 固定路由 + 学到的编排），足以判主命题的编排列；
> 若 P3a 就打不过固定图臂，后两段不必上——直接进 §H.1 负结果处置。

**P3a（只上编排）**
- **交付**：编排 TS 前向 + Python 训练器 + value head；数据飞轮三层数据 + 四道入库闸；
  MCTS / EA 搜索器 + llm teacher（产**固定分解**，全臂共用）；`any` 端口用**确定性固定路由**（选下标最小的已就绪候选）。
- **步骤**：① 白名单特征 / Policy 前向 / `weights.json` arch 硬校验（`encoder_pin` + `action_head` dims + **契约 embedding 表行数 = 池版本** + `MOTIF_MAX` fail-fast）；
  ② 训练器 + F1–F4（§I.3 参考前向逐 bit + §G.18 超参 + `DEV_VAL_N` 早停）；
  ③ MCTS（§J.7，返回 `root_visits` + `graph_visits`；**含 ExTS 质量门**）+ EA（§J.8，**含精英档案**）+ teacher +
     listwise（`τ=1`，`target_dist ∝ N(g)`）；
  ④ 数据飞轮入库四闸 + oracle 生产者拒（§J.11）；⑤ **契约 embedding 表**（append-only 行，不上 MoE）；
  ⑥ **精英档案跨回合持久化**（进 manifest、随 run 冻结；`behavior_bucket` 确定性）。
- **验收**：F1–F4；蒸馏后同任务 pass@1 提升；飞轮四项可观测指标出列；**vs 固定图臂的编排列可读**；
  **精英档案桶覆盖率与各桶精英出列**（§G.26）；**质量门与覆盖诊断联动出列**（§J.7）。

**P3b（加路由 + L2）**
- **交付**：路由模型（`any` 选边、step 级标签、回合末离线更新、执行期冻结）；L2 子图委派与预算切分。
- **步骤**：① 路由前向 + `route_obs`（拉式惰性：不含候选产物内容）；② `edge_choice` ↔ `post` 按
  `(task_id, step, node_index)` join 落盘；③ L2 委派（§J.12，`delegate_reads` + 子图预算独立计 +
  sink→parent outputs 映射 + 未用完不归还 + `pinned_sub` 旁路）；④ GA8⑦ 随机路由臂。
- **验收**：GA8⑦ 可归因；`any_port_density` 达标（否则路由列不可读，记诊断并回到生成器）；子图预算切分正确。

**P3c（加分解 + 思考 +（可选）MoE）**
- **交付**：分解模型（蒸馏分解含再分解）；`THINK` 解码段 + 监督 + 计费；MoE/gate **仅在出现容量诊断时**上。
- **步骤**：① 分解前向 + `MAX_SUBGOALS` + 子目标编码计费（`encoder_cost = task + m · per_subgoal`，按各臂实测 `m`）；
  ② THINK 前缀（§J.13，`ctx.think_used` 累计）+ 监督（§J.16，按步归一 + 无 PV 时不监督停机）+ 关思考臂；
  ③ **若上 MoE**：gate 追加式扩展 + 辅助损失 + 先 mask 后 top-k + `gate_k_shrink` 诊断 + 迁移门禁。
- **验收**：GA8⑧⑬ 可归因出列；`gate_k_shrink` 出列（若上 MoE）。

> 下面的合并步骤清单保留作实现细目索引；执行顺序按上面三段。

- **交付**：分解 / 编排 / 路由 TS 前向 + Python 训练器；MoE + gate 追加式扩展 + 辅助损失 + value head；
  **控制层内思考（`THINK` 解码段 + 搜索中间量监督 + `MAX_THINK` / `MAX_THINK_TASK` 计费）**；
  数据飞轮三层数据 + 四道入库闸；MCTS / EA 搜索器 + llm teacher；L2 子图委派与预算切分。
- **步骤**：① 白名单特征 / Policy 前向 / `weights.json` arch 硬校验（`encoder_pin` + `action_head` dims + `MOTIF_MAX` fail-fast）；
  ② 训练器 + F1–F4（§I.3 参考前向逐 bit + §G.18 超参 + `DEV_VAL_N` 早停 + **未激活专家 wd mask 自检**）；
  ③ MCTS（§J.7，返回 `root_visits` + `graph_visits`）+ EA（§J.8 对齐边集交叉 + `reindex_to_topo_order`）+ teacher +
     listwise（`τ=1`，候选集来自 `graph_visits`，`target_dist ∝ N(g)`）；
  ④ THINK 前缀（§J.13，`ctx.think_used` 累计）+ 监督（§J.16，按步归一 + 无 PV 时不监督停机）+ 关思考臂；
  ⑤ 数据飞轮入库四闸 + oracle 生产者拒（§J.11）；
  ⑥ L2 委派（§J.12，`delegate_reads` + 子图预算独立计 + sink→parent outputs 映射 + 未用完不归还）；
  ⑦ 路由 step 级标签落盘、回合末与编排同频更新（执行期冻结）；
  ⑧ **gate 与 mask 的执行序**（先 mask 后 top-k、`gate_k_shrink` 诊断、辅助损失只在合法位置计）；
  ⑨ **`MAX_SUBGOALS` 与子目标编码计费**（`encoder_cost = task + m · per_subgoal`，按各臂实测 `m`）。
- **验收**：F1–F4；蒸馏后同任务 pass@1 提升；子图预算切分正确；飞轮四项可观测指标出列；**关思考臂与推理档位臂可归因出列**。

### F.5 P4 — 进化外环

- **交付**：指标层（非 LLM，CUSUM）+ manager（提案 schema + `evidence_id`）；漂移 / 结晶 / 生长额度 /
  双集门槛 / 回退闭环。
- **步骤**：① 指标层证据 schema（含 `capability_gap` / `crystallization_candidate` / `coverage_gap` 可判判据）+ 冻结记录读取；
  ② CUSUM 漂移（§J.9 **双侧** + pin 住的 `target` 基线；SPRT 不并行）+ 金丝雀 pending 规则（§J.14）+
     provider 变更时重测并重置状态；
  ③ manager 提案（缺 `evidence_id` 拒）+ 生长额度执法（`GROW_CONTRACT_MAX` / `GROW_INSTANCE_MAX`）+
     **同回合多提案打包成一个 `new`**；
  ④ 采纳闸（硬 / 软 / 未判定）+ **窗口随 `incumbent` 重置** + **按簇不重复的 dev 批采样** +
     `accept`（列全部 `proposal_id`）/ `add_ver` / `set_active` / `quarantine`；
     **检查点回退指针**（最近通过检查点的 `ver`）pin 进 manifest；
  ⑤ 结晶契约合成（§D / §J.6，AND 骨架 post）+ **`composite` 实例与 `bindings.subgraph`** +
     账本三条 `declare`（`capability` → `node`（带 `crystallized_from`）→ `motif`）+ `add_ver`/`accept`，**无专用 `crystallize` op**；
  ⑥ **`audit` 落 defs 链但不进 `worldRev`**（另立 `auditRev`）；审计正文落 `runs/<run_id>/audit/` blob；
  ⑦ **先让它红**（非法 / 无证据 / 无增益 / 超额生长提案必须被拒）。
- **验收**：GA7 / GA8 / GA11。

### F.6 P5 — 报告与归因

- **交付**：结论网格 13 臂跑批；五自变量分解；成本归因报告；如实红记录；**迁移假设清单（§G.24/§G.25 的逐条落地）**。
- **步骤**：① 臂网格 × seeds 跑批；② 四维帕累托 + 三张分层表 + 编码器 / 推理档位 / 关思考消融列；
  ③ 主命题 / 采纳闸判定；④ 待决登记回填；
  ⑤ **成本换量纲**：把 `cost_exec` 结果**同时**折算成 **$/task**（按 pin 的单价与实测 input/output token 拆分）
  与 **P95 延迟**——零额外运行，但这是"研究口径 → 生产口径"的唯一廉价桥，缺了它 §G.25④ 无法判；
  ⑥ **迁移探针**（已采纳，见 §I.2 `probe-real`）：在**真实感族**上重跑**缩减版**（主臂 2 个 × 1 seed × 探针族全量），
  只报"迁移是否成立"与逐条假设状态，**结果不进主命题**（该族明标污染）。探针的两个变体见 §I.2；
  ⑦ **迁移假设清单**：逐条标 **实验内已验证 / 需生产重验 / 已知不可转移**，并给出每条的重验成本估计。
- **验收**：报告落 `runs/`；断点续跑账本等价且不改变结论；**迁移清单齐备且每条有状态**
  （缺清单 ⇒ 报告不可采信，因为"实验全绿"会被读成"可以上生产"）。

### F.7 P6 — 产品化桥（原"后置档"）

- **交付**：**账本与运行时迁内核**、**真实插件池接入**、多 agent 角色分离（触发式）；L3 保持关闭。
- **步骤**：① op 语义映射层（实验 8 defs op ↔ 内核迁移面 8 原语——内核 op 共 10 种，去掉 `batch`/`note`；逐 `kind`/`slot` 定义映射）；
  ② 宿主 + 装配层接入（插件加载、`pins` 拓扑、`stale` 隔离）；③ 沙箱与 exec 端口换生产实现；
  ④ **在真实插件池上重跑迁移清单里标"需生产重验"的条目**（缩减版即可，目的是验证不是重做实验）；
  ⑤ 多 agent 角色分离按触发条件开。
- **验收**：迁移清单里"需生产重验"的条目**全部有结论**（通过 / 不通过 / 不适用，各带证据）；
  **不是**"实验结论复现"——生产域任务不同，复现原结论既不可能也不必要。
- **与旧版的差别（写死）**：原 P6 把「账本迁内核」列为**可选**、触发条件为"出现多宿主/跨进程共享需求"。
  在"先研究、后产品化"下，它是**产品化关键路径**，不是运维需求触发项 ⇒ **改为必做**；
  真正"触发式"的只剩多 agent 角色分离。

---

## G · 默认值（已定；改动须走"提案 → 记账"）

> 所有数值以数据 def 形式住账本，可版本化、可回滚；**调参必须落一条提案与理由，禁静默改**。

| # | 项 | 默认值 | 理由 |
|---|---|---|---|
| 1 | 实验目录 | `experiment/ChronoGraphLab/` | 与既有实验平级、同名风格 |
| 2 | 图文法上限 | `MAX_NODES=12`、`MAX_EDGES=24`、`MAX_DEPTH=6`、`MAX_RECUR=2`、**`MAX_ANY_CAND=3`**（单个 `any` 入端口的候选边数上限）、**`MAX_FANIN=3`**（`cardinality:'n'` 入端口的入边度上限，与扇出 `N≤3` 同源）、**`MAX_SUBGOALS=6`**（分解产出的子目标数上限，封住编码器成本）、**`MOTIF_MAX=32`**（motif 库条目上限，封住 `action_head` 维度）（**无 `MAX_REPEAT`**） | 编码任务的有效编排深度远低于此；上限的作用是**封住搜索空间与 token 长度**，不是能力边界。`MAX_EDGES=24` 对 12 节点 + 扇出 N≤3 聚合偏紧，**P1 用合成任务测"合法图被 `MAX_EDGES` 截断率"，> 5% 则上调或改"入边度上限 per 节点"**。`MAX_ANY_CAND` / `MAX_FANIN` 必须与 `cardinality` 分开：前者管**拓扑候选边数**、后者管**运行时注入数**（《契约与图》§二不变量 2）；`MOTIF_MAX` 触顶后按 `sub_sig` 使用频次淘汰，被淘汰列置零冻结不复用 |
| 3 | 门禁初值 | `Δ=0.05`、`ε=0.02`、`δ=0.05`、`floor=0.05`、`margin=0.02`、`k=3`（结晶次数）、`N=30`（能力缺口）、`SOLVABLE_MIN=0.80`、**`SINGLE_CALL_MAX=0.35`**（不可解族成立条件：单次调用可解率上界）、`HOLDOUT_EVERY=3`、`ESC_ROUNDS=3`（两参数默认同值但**独立**，改一不得默改另一） | 真 LLM 单任务方差大 ⇒ 两处统计条件都写死：**目标命题**用配对差值**单侧 CI 下限 `≥ Δ`**（BH-FDR 校正）；**采纳闸**用**配对非劣检验**——dev 配对差值**单侧 CI 下限 `≥ −δ`**（**配对单位 = 独立簇 `(template_id, k_files, defect_site)`**，簇内先聚合成比例再配对；**检验方法 = 按簇 BCa 自助**（`B=10000`，seed 住 manifest），见 §J.10——簇级成绩是比例不是二元，故**不用** Newcombe/McNemar；`δ` 为预注册**非劣界**）。**`n` = 簇数，由预注册 power analysis 定、`n ≥ 200` 只是下限**；**硬闸额外要求实测 CI 半宽 `h ≤ δ`**，否则本回合只记"未判定"（不采纳、不算失败）。**不得用"`n=200` 时 `h≈0.07–0.10`"去反向抬高 `δ`**；若可负担 `n` 下 `h > δ`，只能走登记提案改 `δ`，并写明可接受的最大退步。**不再另设"点估计非降"条款**（与 `−δ` 容忍度互斥）。**严格提升**（`CI 下限 > 0`）只用于升级触发，不得当采纳硬闸；软闸按 `fit` 改进超过 `margin`（见《进化与账本》§一），两者不是同一判据。**同一 `incumbent` 窗口内每回合判一次须用预注册 group-sequential（alpha-spending）控整体 type-I；窗口的最大回合数、每轮名义 α、累计 n 计划在窗口开始时登记，窗口内禁事后改；`incumbent` 变更 ⇒ 窗口清零并重新登记**。**弃用"两臂 Wilson CI 不重叠"作采纳判据**；Wilson 仅作单臂 pass@1 的展示性 CI。`floor` = 随机合法图臂 pass@1 上限，**区别于**全拒臂的 0-下界 |
| 4 | 模型档位与配置源 | **配置源**：项目根 `.env`（`base_url` + `model_id`；免费 / 调试档用）；网关 = `https://api.kilo.ai/api/gateway`，**免费匿名档**（`api_key` 为空；付费档的密钥走宿主凭据库：OS keychain 优先、退化为权限受限文件，**禁入库 / 禁入 manifest**）。`.env` 现有四档：`stepfun/step-3.7-flash:free`、`thinkingmachines/inkling:free`、`nvidia/nemotron-3.5-lightning:free`、`poolside/laguna-s-2.1:free`。**每 run 从清单选一个并 pin 进 manifest；run 内禁止 fallback 换模型**（换模型 = 转移函数漂移，破坏配对统计）。**档位政策（两档，写死）**：**结论 run 一律走付费 flash 档**（强档 ≈ `GLM-5.3-Flash` / `DeepSeek V4 Flash` 平价第三方 / `GPT-5.6 Luna` 同级；**具体 provider / 模型 id 在首次结论 run 前按登记提案回填本清单并 pin 进 manifest**）；**若当次结论 run 时付费档尚未登记/可用，则维持免费匿名档跑，并在报告显式标注"免费档结论"及其速率/单价限制**；**免费匿名档**（`.env` 现有四档）平时只作 CI / 调试 / 回放。**主档 + 廉价档同门**：强档写代码主力（网关暴露 reasoning 变体则取 `high`，否则 variant 记 `null`）、廉价档同模型低变体（**teacher 及辅助 LLM 调用**：任务分解 / 图候选 / 子图 / 上下文摘要——**非控制层角色**，控制层零 LLM 且内思考）；**执行层节点的 reasoning variant 可逐实例配**（走 `bindings.model`，见 GA8⑫）；**manager 提案归纳用强档**（每回合一次；监控指标层非 LLM，不在此列）。**异模型对照位**：结论档用付费档内的异模型位（启用时登记）；CI / 调试档用 `thinkingmachines/inkling:free` / `nvidia/nemotron-3.5-lightning:free` / `poolside/laguna-s-2.1:free`。**降级链仅在 run 之间**：按启用时登记的档内顺序递减；run 内失败只重试或作废。**pin 进 manifest 的是解析后的 `{base_url, model_id, variant, provider}`**。**端口名定死**：真 LLM 主档 = `model.kilo`，桩/回放同门实现 = `model.replay`，二者缺一不可 | 同门不同 reasoning 变体把"模型能力差异"从对照消掉，测的才是结构与编排；免费档会变动 ⇒ 档位抽象 + manifest pin。teacher / 编码器 / manager 一律 `temperature=0` 并按 prompt-hash 记忆化；IO 只在 `adapters/llm_gateway.ts`（core 零 IO）。限速按指数退避 + 配额账；**限速/超时/失败单列，不并入能力失败**；**退避等待不计入 `walltime` cap**（记 `ratelimit_wait`） |
| 5 | bench 来源 | **自造四族 TS 模板**（§I.2），dev / holdout 各两族：**基线族** dev `dev-lib` `T=20`、holdout `hold-pipe` `T=10`（单点缺陷修复，单次调用可解，作对照基线）；**不可解族** dev `dev-hard` `T=10`、holdout `hold-hard` `T=6`（四机制保证单次调用不可解：超窗 / 高单步失败率 / 冲突约束 / 不可逆首步）。`V̄=32` = `k_files`4 × `defect_site`4 × `rename_seed`2 ⇒ `N_dev=960`（`C_dev=480`）、`N_hold=512`（`C_hold=256`）。按 worst-case `s=1` 的核算式注册，实测 `s` 只许 ≥1 | 现成基准依赖重、易记忆泄漏；Node 沙箱 ⇒ 模板语言 = TS/vitest；holdout 换族不换语言（测编排泛化不是测语言迁移）。**必须有不可解族**：若全部任务单次调用可解，GA8① 会打平、主命题先天不成立——那反映的是任务域选错，不是编排无用。两族**分开报**、`SOLVABLE_MIN` **各自达标**、`dev-hard` 另需单次调用可解率 ≤ `SINGLE_CALL_MAX=0.35` |
| 6 | 控制层规模 | 专家数 ≤ 32（= 契约数上限；触顶须走「控制层容量」档或并入既有契约的 `role`/子类型）、`top-k=2`（**mask 后合法专家数 < k 时 k 退化为合法数、记 `gate_k_shrink`，不补非法专家**）、参数量 ≤ 2M（含 `value head`、`action_head`、思考模块；**不含 `trainable` 节点自身权重**，后者单列；**容量诊断触发时走「控制层容量」档，上限提至 ≤ 8M**）、`MAX_THINK=16`（每模型每次生成）、`MAX_THINK_TASK=64`（**仅约束路由**每任务思考总量；编排/分解每次生成受 `MAX_THINK` 约束、不受此约束）、MDL 结构项 `μ` = 0.01、成本项 `λ` = 0.10（`cost_exec` 已归一化到 [0,1]，**不含 walltime**） | 控制层是**小模型**：要能在 CPU 上训、能逐字节重放。专家数必须与契约数同阶，否则路由无信号。思考 token 是控制层自己的 decode、按 token 计费，故不破坏零 LLM / 可重放；`MAX_THINK` 初值住账本、可版本化。`MAX_THINK_TASK` 只管路由是因为路由按 `any` 端口数反复思考、次数随图规模增长；编排/分解每任务各一次，`MAX_THINK` 已足够 |
| 7 | 冷启动 | 未知能力兜底专家（零初始化）+ 契约级默认提示词 + 新实例**影子模式**（**转正判据写死**：在金丝雀集上累计 `n ≥ CANARY_MIN_N` 且**未置零的原始 Wilson 单侧下界** ≥ 同契约在位实例者，才允许被编排选中；未达 `n` 前保持 shadow） | 不设影子期，新实例会以未训状态吃预算并污染统计 |
| 8 | 自治 L3 | **起始关闭，但排在升级阶梯上**：P4 全绿 + 归因测试通过 ⇒ 上升 | 归因不清时开 L3 = 结论不可信；但永久关闭等于放弃了"节点自产拓扑"这条能力线 |
| 9 | 账本 | **起始 standalone**；**产品化路径上必做**（不是运维触发项，见 §F.7）：接内核（`Entry` **字段形状**已对齐；**op 集合不同、须经 op 语义映射层**，非"只换存储"）。**触发 = 决定产品化**，不再等"多宿主/跨进程共享"这类运维信号 | 先跑通实验，别提前承担引导器/装配层成本；但"先研究、后产品化"意味着它**迟早必做**，故列为 P6 必做项而非可选 |
| 10 | 扇出-聚合 | `N ≤ 3`；聚合契约三选一（`vote` / `judge` / `merge`）；**N 路全计费** | 全计费让成本惩罚自然抑制滥用，不需要额外门禁；只计采纳路会让 N 免费膨胀 |
| 11 | 回合与预算 | `ROUND_DEV_N = 100`（任务数；**按簇整取** ⇒ 50 个完整簇，不切开簇）、`ROUND_B` = `Σ_i B_i`（**当轮实际执行任务的 cap 之和 = `new` 与 `incumbent` 各一遍**；任务 spec 的预算上限可逐任务不同，**不可写成 `ROUND_DEV_N × B`**；运行时控制层 decode 已含在任务 `B` 内，**不重复计入**）+ `search_cost`；holdout 判分成本单列 `holdout_cost`、不计入 `ROUND_B`；**holdout 每 `HOLDOUT_EVERY = 3` 回合 + 结论回合判一次**，检查点判定用 BH-FDR 校正、判分次数入账；**采纳判定要求 `new`/`incumbent` 当轮共评同一 dev 批**；**`ESC_ROUNDS = 3`**（连续 3 个**已判定**回合 **pass@1_dev 无严格提升** ⇒ 触发升级阶梯上升一档；"未判定"回合不计入停滞；不以 fit 无提升为触发） | `ROUND_DEV_N` 太小则 Δ 是噪声、太大则世代推进慢；`ESC_ROUNDS` 太小会频繁加旋钮、太大则卡死。**`n` = 簇数，由功效分析定、`≥ 200` 是同一 `incumbent` 窗口内的累计下限**（单回合仅 50 簇 ⇒ **最快第 4 回合才可能判定**；`incumbent` 一变窗口清零）。报告须标注窗口起止回合与累计簇数。**代价明写**：采纳节奏 ≈ 每 4 回合一次；绑定/权重变异不写 `add_ver`、不受此限，照常每回合迭代 |
| 12 | 漂移统计口径 | 每契约金丝雀集 = 20 个 dev 任务（固定、pin，作**基线可比**用）；检测统计量 = **CUSUM**（成功率 + 声明了 `confidence` 时的 ECE；阈值按目标 ARL 预注册，**双侧各一条状态**：下降侧检能力退化、上升侧检"意外变好"——后者同样是漂移证据，provider 换模型可能变好），累计该实例在 dev 上的**全部调用**；报告仍出 Wilson 下界作展示。**CUSUM 的 `target` = 该实例转正时在金丝雀集上的成功率基线，pin 进池版本**（不用滚动均值作 target，否则缓慢漂移会被 target 跟着漂、永不触发）。**SPRT 不得与 CUSUM 并行**（两套阈值会给出冲突隔离决策）；改用 SPRT 须提案替换并重注册 ARL。**模型 id / provider 时间戳变化 ⇒ 强制重测金丝雀**（重测后重置 CUSUM 状态并记 `note`，否则换版前的累积量会立刻误触发）。**`llm` 节点不可 memo ⇒ 漂移检测的样本不含 memo 命中**，检测面完整 | 固定 n=20 的 Wilson 下界功效严重不足（SE≈0.11），会"要么不触发、要么误报"；序贯检测用全部调用流、按 ARL 控制误报。真 LLM 最现实的漂移源是 provider 静默升级 |
| 13 | 对称消融 | 绑定变异一律**强制指定实例**评估；`test_pass_fraction` 只作诊断列 | 不强制指定则绑定效果与实例选择混淆；部分通过口径若进接受闸会诱发刷分 |
| 14 | 防冗余阈值 | `redundant_step_rate ≤ 0.10`、`wasted_budget_rate ≤ 0.20` | 与 GA13 判据同源；超界记退化、先诊断，不直接回滚 |
| 15 | 回填默认值 | MoE 辅助损失 `α = 0.01`；飞轮 `WINDOW = 3`、`TRAIN_WINDOW = 5`；`theta.pos_rate = 0.05`、`theta.drift = 0.25`（PSI）、`theta.gap_rate = 0.40`、`theta.gap_repair = 0.30`、`theta.cov_gap = 0.15`（覆盖缺口：该难度档 `S_dev` 低于全档中位数的幅度）、`theta.calib = 0.90`；`compile_reject_rate` 告警线 `0.10`（`publish_order` 单项 `0.05`）；`any_port_density` 诊断线 `0.10`；`sig` 同构重复率诊断线 `0.20`；**`fit_H_imputed` 占比诊断线 `0.10`**；listwise 长度归一指数 `γ = 1.0`；`EXPAND_FAIL_MAX = 64`；自助重数 `B = 10000`（seed 住 manifest）；`θ_l2 = 0.4`（L2 预算切分比例）；**`AUDIT_KEEP_ROUNDS = 5`**（审计 blob 保留回合数；过期只删 blob、保留 `audit` def） | §I.1 回填项的可调默认；全部住账本、可版本化，改动须走"提案 → 记账"。原表把 `theta.*` 四项与 `compile_reject_rate` 混写成同一个 `0.10`，语义不同、量纲不同，此处拆开逐项给值。**设计文档引用为"诊断线/住账本"的项必须在此有落点**——缺了就会出现"设计说住账本、账本里没有"的空引用（`AUDIT_KEEP_ROUNDS`、`fit_H_imputed` 线是补的两处） |
| 16 | 生长额度 | `GROW_CONTRACT_MAX=1`（新 `contract_id`，含结晶）、`GROW_INSTANCE_MAX=3`（新 `NodeDecl`，含结晶那 1 个）；绑定/权重变异不占；超额提案本回合拒、证据保留 | 一次只采纳有限生长才能归因；额度不是证据门的替代 |
| 17 | EA | `EA_POP=32`、`EA_CX=0.5`（每对同 `family_sig` 父代以该概率交叉）、每选中父代必变异一次；帕累托维 `{pass@1↑, cost_exec↓, H↓}` | 种群与契约上限同阶；交叉失败丢弃（`invalid_crossover_rate`），不回退成父代拷贝（否则交叉名存实亡） |
| 18 | 训练超参 | AdamW `lr=3e-4` `β=(0.9,0.999)` `ε=1e-8` `wd=0.01`；`batch=16` 任务；`τ=1.0` **不退火**；`grad_clip=1.0`；`max_epoch=50`；`patience=5`（val listwise 无提升早停）；`DEV_VAL_N=64`（冻结 dev 切片，不进搜索/蒸馏，可与金丝雀重叠）；THINK `λ_th=0.10` `λ_v=0.05` `λ_stop=0.02` | 小模型 CPU 可训；τ=1 让 visit 自己携带峰，再退火等于多一个会藏欠拟合的旋钮；visit 过尖由已有「蒸馏 \|V\| vs 搜索 \|V\|」诊断触发提案改 τ。val 切片满足 F4，且不占用 holdout |
| 19 | 泄漏扫描 | `theta.ast_sim=0.60`（holdout 模板 vs 任一 dev 模板的 token-type bag 余弦）；超阈 ⇒ 该 holdout 模板不得入池 | 仅任务哈希不够；同语言不同族仍可能 AST 撞车 |
| 20 | **per-task cap `B`**（原表缺，缺了成本无法预算、`cost_exec` 分母无值） | **基线族**（`dev-lib` / `hold-pipe`）`{ calls: 12, tokens: 60_000, tool_calls: 8, walltime: 300s }`；**不可解族**（`dev-hard` / `hold-hard`）`{ calls: 16, tokens: 120_000, tool_calls: 10, walltime: 420s }`；逐任务可再覆写，pin 进 task spec | 基线按活动子图 4–6 节点 × L1 平均 1.4 次尝试 ≈ 6 次调用的**中位**执行标定，留 2× 余量。不可解族 `tokens` 翻倍是**结构性的**：A 机制（超窗）的必读上下文本就大于一次调用的窗口，`f_ctx` 3–5 档任务按定义要读更多。**两族 cap 不同不破坏"同预算"**——同预算是**同族同 cap**（臂间比较），不是跨族同 cap（族间本就不是同一分布）。**`calls` 是硬上限，不是目标**——`used/cap` 进 `cost_exec`，用满即满分惩罚。GA8① 单节点臂共用同族 cap（它只花 1 次 call，这正是它的成本优势，必须可见） |
| 21 | **搜索规模与质量门**（原表缺，缺了 `search_cost` 与 `ROUND_B` 算不出） | `MCTS_ROLLOUT = 30`（每任务展开次数）、`SEARCH_TASKS_PER_ROUND = 100`（= 全批；即每回合每个 dev 任务都搜）、`EA_GEN_PER_ROUND = 2`；**ExTS 质量门（§0.5-B）**：`τ_gate = 0.5`（扩展质量门；`0` = 退化为原无条件扩展）、`VIRTUAL_CHILD_N = 4`（虚拟子节点采样数）、`sigma_floor`（窄分布阈值，用于 discriminative shaping） | 前两个数**直接乘进总成本**：`rollout` 30→100 会让全实验 token ×2.5。30 是"够产多解、又不吃满预算"的起点；不足则由「搜索正样本产出率」诊断触发提案上调，**不许静默改**。`rollout` 的每次展开都要真跑验收 ⇒ 它是全实验最贵的单项，**这正是借 ExTS 质量门的理由**。**质量门必须与覆盖诊断同出列**：`τ_gate` 与 `sig` 同构重复率、`any_port_density` 一起报；覆盖恶化 ⇒ 回退 `τ_gate=0`（§J.7） |
| 22 | **模型档位的成本现实**（决定能不能跑完，非可选项） | **付费 flash 档为默认真实运行档**（`GLM-5.3-Flash` / `DeepSeek V4 Flash` 平价第三方 / `GPT-5.6 Luna` 同级，按 §G.4 档位政策与登记清单 pin）；**付费档未就绪时维持免费匿名档跑并在报告标注"免费档结论"**；**免费匿名档平时降级为"调试与 CI 回放档"**。全实验估算（**新增 `dev-hard`/`hold-hard` 前的基准**）≈ **190,000 次任务执行 / 约 100 万次 LLM 调用 / ≈ 5.6B 输入 + 0.7B 输出 token**，flash 档带提示缓存 **$900–2,200**；含调试重跑 2–5× ⇒ **$2,000–7,000**；**引入两族后本组数字须按同式重算**（dev 池 640→960、hold 池 320→512），重算值 P2 定稿回填（§I.2 ④ 不另记绝对值） | **钱不是瓶颈，速率是**：100 万次调用在免费档 ~20 RPM 下 = **35 天不间断**且日配额先撑爆；付费 flash 档 10 req/s 下 ≈ **28 小时**。故默认免费档只跑 canary 与回放；**若结论 run 时付费档未就绪而维持免费档，必须在报告标注"免费档结论"及速率/单价限制**。**提示缓存必须开**（系统提示 + repo 切片约 60% 输入可缓存，省约 1/3 总价）⇒ `prompt` 与 `context_policy` 的拼装顺序须把**稳定前缀放前面**（缓存命中的前提），这是架构约束不是优化。**成本需要削时的第一杠杆 = 臂子集化**：结论网格 13 臂里 5 个主臂（主命题）跑满全池，8 个消融臂是**方向性**结论、跑分层 1/3 子集即可（省约 9% 总价，代价是消融列 CI 变宽、需在报告里标注子集规模）；**④全拒臂只作 GA3 门禁用，不进结论网格**。**第二杠杆 = 降 `MCTS_ROLLOUT`**（线性省，但直接削弱搜索质量，**不推荐**）。**禁止**的杠杆是砍族——不可解族是主命题能否立起来的前提 |
| 23 | **代理内循环**（定位已调整） | `proxy` 节点行为模型（给定 `(contract_id, 难度向量, variant_index)` 的 `post` 通过概率与四维成本分布，从 ≥ 500 次真调用标定）；**用途 = CI 门禁、训练代码调试、超参扫描**；**不得**用于任何写进结论的 run | 原以为代理是可行性前提（免费档跑不完），实测成本后**降为迭代速度工具**：改一行训练代码不必等一天。相应地，**代理保真度门禁**（代理与真 LLM 在同一批图上 pass@1 的 Spearman ≥ 0.7）只约束"能否用代理调参"，**不**约束结论——结论一律真 LLM。这条避免了"代理 gap 污染主命题"这个原本会很难辩护的风险 |
| 24 | **"真实运行"的准入条件（三轴区分，防"实验过了 ⇒ 生产可行"的误推）** | **轴① 代理 vs 真 LLM**：分界 = **该 run 的结果是否进结论**。**自 P1 起，一切产证据的 run 一律真 LLM**；代理只跑 CI/调试/超参扫描，其结果永不进结论。**"真实运行"是准入条件，不是某个阶段**。**轴② 实验 vs 生产**：分界 = 是否接内核、插件是否真实。**轴③ 合成 vs 真实任务**：分界 = 任务来源是否真实。 | 三轴**正交**，把轴① 的"真实"读成轴② 的"生产"是最容易犯的误推。**本实验只证明"机制 M 在 (任务分布 D, 池 P, 成本模型 C) 下有效"，不证明 (D′, P′, C′) 下有效**——两者的落差见 §G.25。故 P5 交付物必须含**迁移假设清单**（每条假设标：实验内已验证 / 需生产重验 / 已知不可转移），否则"实验全绿"会被当成"可以上生产" |
| 25 | **六项迁移落差（实验→生产，按载荷排序；这是"研究可行 ≠ 生产可行"的具体内容）** | ① **验证器**（最深）：飞轮的监督来源是隐藏测试自动判分；真实任务常无自动验证 ⇒ 正样本产出率从"稀有"变"常态为零"，**燃料断点成为默认态**。这是**产品域前置条件**，实验测不了。② **池规模**：实验契约池是 toy 且 ≤ 32；真实插件生态远超 32，而专家/`NODE_SLOT` 维度上限 32 是硬约束（触顶须并入既有契约或走容量档）⇒ 该上限会先撞上。③ **特征面**（已知未解）：逐节点 obs 在实验里是 toy 产物，生产里是真实代码/文档/工具输出；"逐节点 LLM 编码"是后置档。④ **成本量纲**：实验用归一化 `cost_exec`（calls/tokens 按固定权重混，输入输出单价差 3–6 倍），生产看 $/task 与 P95 延迟 ⇒ 帕累托前沿结论未必在 $ 空间成立。⑤ **运行时是两套代码**：实验 standalone、不接内核；生产是宿主+装配层+插件 ⇒ executor/契约加载/沙箱均须重验。⑥ **固定图臂公平性**：实验 `|V_seed|` 由研究者手写；生产的"固定图"是产品实际 ship 的编排，若其不弱则自适应臂未必赢 | **桥的形态不是"实验完再做一次生产验证"，而是让实验顺带产出迁移清单 + 逐条廉价检验。** 已采纳：**`probe-real` 迁移探针族**（真实感契约池 + 接近真实的仓库，**明标污染、绝不进主命题**）⇒ 轴②③ 的 D′/P′ 在实验内即测；**`probe-real` 的变体 ②（弱监督）**另测落差①。只剩运行时轴（⑤）留给 P6。**另**：P6 把「账本迁内核」列为*可选*（触发条件 = 运维需求），但在"先研究、后产品化"下它是**产品化关键路径**，不是运维触发项——已改为 P6 必做 |
| 26 | **精英档案（QD，§0.5-A）**（原表缺，缺了"防坍塌"无机制落点） | `ARCHIVE_SEED_K = 8`（每代从档案采样的精英数）；行为维度分桶数 `VBINS=4`（`|V|` 档）、`DBINS=3`（最大深度档）、`CBINS=3`（`cost_exec` 档）、`KBINS=3`（契约多样性档）；档案**跨回合持久**、进 manifest | 原设计只有 `Ei` / 熵**诊断**，没有机制干预；而 `GROW_CONTRACT_MAX=1` 下池增长慢、易坍塌到单一行为区。档案按**桶**均匀采样（不是按个体均匀），否则大桶淹没小桶、QD 失效。**档案的每桶精英必须进报告**（否则等于没做）；**档案桶覆盖率**进诊断列，覆盖下降 = 探索退化，触发升级诊断。分桶函数必须确定性（同图必落同桶），否则档案不可重放 |
| 27 | **成熟度门（PSN 式，§J.6）** | 成熟判据：该结晶节点在金丝雀集上的成功率下界连续 `MATURITY_ROUNDS = 3` 回合不劣于其子图展开式，**或**累计调用次数 ≥ `MATURITY_CALLS = 20`。成熟 ⇒ 不进梯度且 `wd` 也 mask；未成熟 ⇒ 保持可塑 | 与惰性训练的"未激活专家不更新"是同一件事的两面。**不设永久冻结**——成熟只影响更新频率，仍可 `set_active` 回滚 |
| 28 | **本轮补齐的统计/运行默认值**（原散落正文，统一住账本） | `alpha_lb=0.05`（实例 `success_lower_bound` 的 Wilson 单侧置信水平）、`CANARY_MIN_N=20`（影子转正所需金丝雀样本数）、`REJECT_REPEAT_MAX=2`（同 `(type,target)` 提案连续被拒上限）、`VERIFY_TIMEOUT=120`（判卷硬超时，秒）、`GAP_PROBE_K=8`（能力缺口重连上界探针张数） | 这些值此前只在 §I.1 / §J 正文内联，属"设计说住账本、账本里没有"的同类漏网；集中登记后 `success_lower_bound` / 影子转正 / 提案去重 / 判卷超时 / 缺口探针全部可复算 |

其余探索性项（L3、迁内核、上调专家数）一律走"先登记后扩展"。

### G.1 指标与公式（实现用）

```
cost_exec(G) = Σ_d w_d · min(used_d, cap_d) / cap_d,  d ∈ {calls, tokens, tool_calls}, Σ w_d = 1
默认 w = { calls:0.40, tokens:0.40, tool_calls:0.20 }   （住账本，可版本化）
# min(used,cap) 保证 cost_exec ∈ [0,1]（λ 的量纲前提）；溢出量单列 cap_overshoot_d，不截断上报
# walltime 进 cap 硬停与 used_ext 帕累托，不进 cost_exec / fit（不可逐 run 复现）

fit(G) = pass@1_dev(G) − λ·cost_exec(G) − μ·H(G)        # 单图口径
# 版本级 fit = 当轮 dev 批上 fit(G_i) 的任务等权均值；接受闸比较版本级 fit，非单图
# incomplete 任务：pass@1=0、cost_exec 按**实际消耗**计（不按 cap 计满，否则提前停被双重惩罚）、
#   H 取该任务实际产出图；未产出闭合图者 H 用当轮中位数插补并记 fit_H_imputed
#   （插补占比 > 0.10 ⇒ 该轮 fit 只作诊断、不进软闸）
H(G)   = (|V|+|E|)/|V_seed|      （|V_seed| = GA8② 人工固定图臂节点数，**按任务所属族取**，P2 pin 进 manifest）
# composite 节点按 1 计入 |V|（结晶降 H 的落点）；其内部节点不计——这正是「H 降、cost 不降」的原因

ECE = Σ_b (n_b/n)·|avg_conf_b − emp_pass_b|   （按 bin 样本数加权；bin 划分与 n 入 health；
                                                无 confidence 输出位的契约不判 ECE）

搜索正样本产出率 = solved / rollout（另报 meanReward）
Ei = D_KL(π_policy ‖ π_search)（bits）；H(π) = 按 family_sig 分桶归一化后的香农熵（bits）
# 支撑集 = 本回合两者出现过的 family_sig 并集；两侧各 add-one 平滑（分子+1、分母+|支撑集|）后算 KL
# 跨回合比较 Ei 必须同时报 |支撑集|——支撑集变大本身压低 Ei，不标注会把「探索变多」误读成「共退加剧」
共退判据 = Ei 与 H(π_policy) 同向单调下降

any_port_density(G) = (# any 入端口) / (# 全部入端口)；图平均过低（< 0.10）记诊断
used_ext 搜索分摊（**仅搜索进运行时档下**）：search_cost_d / n_eval_tasks（当轮实际评测任务；未评测不分摊；四维各自独立）；默认离线搜索档 `used_ext` 不含 `search`

listwise：s(g) = (1/|tokens(g)|) · log p_θ(g)；  q(g) ∝ exp(s(g)/τ)
# 禁止写成 p_θ(g) 出现在等式两边的记号滥用

wasted_budget_rate = Σ cost(wasted_step) / Σ cost(executed)
# DAG 下 wasted_step 只来自 L1 重试与 composite 内部 ⇒ 该比率实质是 L1 空转率，报告须标注该口径
redundant_step_rate = (# redundant_reject + # wasted_step) / # scheduled_or_executed
invalid_crossover_rate = (# crossover returned null) / (# crossover attempted)
greedy_completion_rate = (# 被贪心补齐的边) / (# 全部边)      # 原文写「被补齐节点/总节点」但补齐加的是**边**
L = L_listwise + λ_th·(L_pv + L_plan) + λ_v·L_value + λ_stop·L_stop + α·L_gate
# 各 think 项按步数归一（否则 T 大的样本梯度天然更大 ⇒ 学「多思考」刷 loss 尺度）
# L_gate 只 NODE 位置、只在「搜索器选的契约本身合法」的位置上计
# wd 由 AdamW decoupled 施加，不进 L；未激活专家的 wd 须 mask（惰性训练）

memo 键 = H({task_id, node_index, contract_ref, 输入 slot 版本向量, 解析后的 reads 版本向量,
             生效 bindings pin, variant_index})
# memo 只适用 trainable / 无端口 tool / 全 exact 的 composite；llm 节点一律不可 memo
```

**接受闸判定过程（实现）**

```
配对单位 = 独立簇（template_id, k_files, defect_site）；簇内换名副本先聚合成比例
窗口     = 当前 incumbent 生效以来的累计簇；采纳或回滚 ⇒ 窗口清零、group-sequential 重新登记
硬闸：dev 簇级配对非劣检验成立（BCa 自助，B=10000）：
      单侧 CI 下限 ≥ −δ，累计**簇数** n ≥ max(200, 预注册功效分析所需 n) 为前置；
      且实测 CI 半宽 h ≤ δ，否则本回合只记"未判定"（不采纳、不算失败）；
      且（仅检查点回合）S_holdout(new) ≥ S_holdout(incumbent) − ε
      # 非检查点回合的采纳只过 dev 硬闸 ⇒ 最多两代后才发现 holdout 退步；
      # 检查点回退目标 = 最近一个**通过检查点**的 ver（不是上一代），该指针 pin 进 manifest
软闸：fit(new) > fit(incumbent) + margin（cost / H 改进只记账）
采纳：一回合内通过额度执法的**全部提案打包成一个 new**，一起判、一起 add_ver 或一起作废；
      accept entry 列出打包内全部 proposal_id；写只增版本目录 + hash 链 + manifest
```

**评估协议**

- 采纳闸：**同一 `incumbent` 窗口内**累计 `n ≥ max(200, 功效分析所需)` 个独立簇（跨回合累计、**按簇不重复**；`n` 是簇数不是任务数，**不按难度档分别计**）
  **且**配对非劣检验成立（dev 簇级配对差值单侧 CI 下限 ≥ −δ **且实测半宽 ≤ δ**）；
  **`n` 是簇数不是任务数；`n ≥ 200` 是下限，不是替代判据**。严格提升（CI 下限 > 0）另作升级触发判据；软闸按 `fit` 改进超过 `margin`（《进化与账本》§一）。
- **主命题另立判据**：vs `fixedgraph` 的**簇级**配对差值**单侧 CI 下限 ≥ Δ**（**BH-FDR 校正族 A = 分层归因各档**：难度 / 契约 / 自治三表分桶；整体单一检验无须 BH-FDR），点估计并列。
  **主命题不受"窗口随 incumbent 重置"约束**——它比的是"自适应臂 vs 固定图臂"，两臂都不是 `incumbent`，
  可用全部 **480** 个 dev 簇一次性判定（结论回合判一次，不做重复检验，故不需要 group-sequential），
  **且必须按族分栏**（`dev-lib` 320 簇 / `dev-hard` 160 簇）。
  **检查点 holdout 的 BH-FDR 是独立校正族 B**（按检查点次数），与族 A、与采纳闸的 group-sequential **不共享 α**。
  - 臂网格 = **13 臂**（= 自适应臂 + GA8 ①–⑬ 去掉只作 GA3 门禁用的 ④全拒臂）× **≥ 3 个 seed**；主表先出 5 个主臂
    `{自适应, 单节点①, 固定图②, 随机合法图③, 无搜索纯生成⑤}`，消融臂 ⑥⑦⑧⑨⑩⑪⑫⑬ 按 GA8 补齐；④全拒臂不进结论网格。
  **可用时点按 P3 分段**：`⑥⑧⑨` 与主臂 `{自适应, ①, ②, ③, ⑤}` 在 **P3a** 即可出（它们只依赖编排 + 固定分解 + 固定路由）；
  `⑦`（同图随机路由，需"学到路由"作对照）与 `⑩`（自治档位，含 L2）在 **P3b** 后；`⑬`（关思考）与 MoE 相关项在 **P3c** 后；
  `⑪`（池冻结）在 **P4** 后。**每臂在其可用时点即可进报告，不必等齐**——这也是分段的主要收益；
  报每格均值 + CI。
- **配对比较**：**同簇、同 seed 配对，且 `new`/`incumbent` 在同一 dev 批上共评**，报**差值的 CI**；
  不做非配对均值比较（真 LLM 方差大，非配对比较会把噪声读成增益）。
  **同簇的 2 个 `rename_seed` 任务必须落在同一回合同一批**（否则簇级聚合跨批、配对不成立）。
  `rename_seed` 两档间的成绩差单列 `rename_variance`（记忆化 / 表面形式敏感性诊断）。
- **断点续跑**：真 LLM run 很贵，任务级结果逐个落盘；续跑与一次跑完必须账本等价，且**续跑不得改变结论**——
  若改变，说明存在未入账的状态。**等价硬约束只作用于确定性维度 `calls`/`tokens`/`tool_calls` 与 `pass@1`/`S`；
  `walltime` 因含 IO/网络不可逐 run 复现，进报告（中位数 + 自助 CI）但不进结论等价硬约束**。
- 如实红：任何门禁红了就红着记录；**不得**为了让报告好看而重跑直到偶然变绿（重跑次数入账）。

**成本与归因报告（每次 run 必出，缺一即不可采信）**

`S_dev / S_holdout / cost_to_solve（对外四维 `used_ext` 帕累托前沿 + 各维中位数；`used_ext` 含编码器成本与（搜索进运行时档下的）pro-rata 搜索成本）/ incomplete_rate / verify_timeout_rate / cap_overshoot / redundant_step_rate /
wasted_budget_rate（标注 = L1 空转率）/ greedy_completion_rate（按边）/ compile_reject_rate（分 reason）/ invalid_crossover_rate / gate_k_shrink_rate /
**any_port_density（OR 分支端口占比；低 ⇒ 路由无落点、GA8⑦ 测不出）** / branch_not_taken 比例 / 搜索正样本产出率 / Ei 散度（含 |支撑集|）/ 训练集分布漂移 /
蒸馏目标 |V| 分布 vs 搜索产出 |V| 分布 / rename_variance / fit_H_imputed 占比 / sig 同构重复率 /
**精英档案桶覆盖率与各桶精英清单（§G.26；覆盖率下降 = 探索退化，必须与 motif 表同页）** /
**质量门参数 `τ_gate` 与覆盖诊断的联动（§J.7：`τ_gate` 必须与 `sig` 同构重复率、`any_port_density` 一起出列）** /
**失败聚类表（按 `(RefusalCode, attributable_to)` 分组的计数与占比）** /
**成本事件流对账表（各 `attributed_to` 视图之和 vs 事件流总量，差额须为 0；含每视图的 `counts_against_cap` 口径）** /
每实例金丝雀统计（含 CUSUM 双侧状态）`，以及**三张分层表**：按难度向量分档（**六维**）、按契约分档、按自治档位分档，**外加编码器 / 推理档位 / 关思考消融列**；
**再加两张 motif 表**（Top-motif × 难度档通过率矩阵、`Δ_motif` 排序表含簇自助 CI，见 §I.1 motif 库）——
这两张是"模型学到了什么结构"的唯一产出面，**负结果下仍必须出**。
**全部主表按族分栏**（`dev-lib` / `dev-hard`）：基线族与不可解族的预期结果不同，混报会淹没信号。
**统计口径必标注**：每次判定的**窗口起止回合 + 累计簇数**；分层表须写明各列的固定条件（哪些 pin、哪些随之变化），
**分层各列不可相加**得总增益（五自变量不完全正交，见《总览》§1.3）。

---

## H · 升级阶梯与后路

**原则**：**关闭的功能不是删掉，是排在阶梯上**。两条上升通道——**阶段门**（某阶段验收全绿 ⇒ 解锁下一档）
与**失败驱动**（连续 `ESC_ROUNDS` 个回合 **pass@1_dev 无严格提升** ⇒ 上升一档）。**一次只上升一档**、
必须登记假设与**预注册预期收益**；上升后重跑门禁、必要时 arch bump 重训；每一档都可回退
（`set_active` 指回上一 `ver`）。

| 机制 | 起始档 | 上升触发 | 上升后必须做 | 回退 |
|---|---|---|---|---|
| 生长 · 实例级 | 新实例挂**已有契约** | 默认（无需上升） | — | — |
| 生长 · **契约扩展** | 关闭 | 连续能力缺口（≥ `N` 任务）且"实例级"手段全部试过仍不达标 | 新 `contract_id` ⇒ **专家追加 + arch bump + 重训 + 门禁重跑** | 回上一 `ver` |
| 自治 **L3** | 关闭 | P4 全绿 **且**归因测试通过（**指标层**能区分"编排产拓扑"与"节点产拓扑"） | 归因门禁成为硬前置；L3 产出仍过图文法闸与同一预算账 | 关回 L2 |
| 搜索进运行时 | 关闭（离线） | P3c 全绿 且 离线搜索的正样本产出率见顶 | 搜索成本按任务数 **pro-rata 计入对外四维 `used_ext`**（规则住账本、所有臂共用），仍不进 `cost_exec`；展开顺序确定 ⇒ 运行时搜索仍可重放 | 回离线 |
| 账本迁内核 | 关闭（standalone） | **决定产品化**（不是运维信号——见 §F.7 与 §G.25） | `Entry` 字段形状已对齐，但 **op 集合不同、须经 op 语义映射层**（非"只换存储"）；映射后 `verify`/`replay` 接管回滚验证 | 回 standalone |
| 沙箱 | Node 目录隔离 | 出现越权 / 逃逸证据，或需执行不可信代码 | 升 Rust 沙箱 / 容器；`exec` 端口换实现，**契约不变** | 回目录隔离 |
| 扇出上限 | `N ≤ 3` | 出现"多路显著增益且**全计费下**仍划算"的证据 | 上调 `N`；报 N-成本曲线 | 回 3 |
| 并行化拓扑执行 | 关闭（串行） | 串行 `walltime` 成为瓶颈，**且**跨分支 publish 已改为在显式 join 契约处合并版本 | 并行执行；并行度进 manifest；`walltime` 改有效挂钟口径；报并行度-成本曲线 | 回串行 |
| 控制层容量 | 专家 ≤ 32、参数 ≤ 2M | **容量诊断**（欠拟合证据），而不是仅"不达标" | arch bump + 重训 + F1–F4 | 回旧 arch |
| **潜思考步（latent）** | 关闭（token 化 THINK） | P3c 全绿 **且** THINK 收益见顶（关思考臂不再出增益），**且** 计费 / 停机 / 可重放口径登记完成 | 定义无 token 思考的计费与停机口径；开消融臂对照 token 化 THINK | 回 token 化 THINK |
| **motif 库上限** | `MOTIF_MAX=32` | 淘汰频次持续 > 0（说明 32 条不够装稳定 motif），**且** `action_head` 在被淘汰 motif 上的历史命中率显著 | 上调 `MOTIF_MAX` ⇒ `action_head` 追加列 + arch bump + 重训 | 回 32（超出列置零冻结） |
| **图同构规范化** | 关闭（`sig` 按生成序） | `sig` 同构重复率 > 0.20（去重失效、listwise 候选集里塞满同构副本） | 加规范化档（受限同构：只对**同 `family_sig` 且节点数 ≤ 8** 的图做规范化，避免 NP-hard 全图同构）；`sig` 口径变更 ⇒ 全历史去重键作废、需重建 motif 库与训练集去重索引 | 回生成序 |
| **拉式 → 推式执行** | 拉式惰性（OR 省预算） | 出现"路由因看不到候选产物而系统性选错"的证据（同图强制枚举各分支的离线对照显示：后验选边的 pass@1 显著高于先验选边，且差值 ≥ `Δ`） | 改推式后验选边；**OR 不再省预算** ⇒ cap 与 `cost_exec` 口径不变但实测成本上升，须重跑全部成本结论；与"扇出-聚合"的语义重叠须重新划界 | 回拉式 |
| 多 agent 角色分离 | 指标层 + 单 manager | P5 全绿 | 诊断（证据）/ 提案 / 做题三方分离，成为结构前置 | — |

**禁止**：同时上升两项（归因不出）；跳档（跳过中间档）；把"不达标"直接当成"该上升"——**必须先是可署名的
失败证据**（能力缺口 / 漂移 / 覆盖缺口），并登记假设与预期收益。

> `ESC_ROUNDS` 的 pass@1_dev 停滞是**检测信号**而非可署名证据本身：它触发"进入诊断"，但任一档的**上升**
> 仍须先定位到能力缺口 / 漂移 / 覆盖缺口并登记预期收益——停滞本身不许直接当成"该上升哪一档"。

### H.1 负结果与事故的后路（预先写好）

- **负结果处置**：若单节点臂打平 ⇒"编排有增益"**判负**。处置不是删档，而是**缩小声明**：改为
  "在 ≥ 某难度档 / 某任务族上编排有增益"，并给出**分层归因表**；若分层后仍无一处增益 ⇒ 结论为
  "编排在本域无效"，照实发表，并触发**域侧复查**（任务难度分布是否根本不产生编排收益），而不是继续加旋钮。
  **判负必须先看分族**：`dev-lib`（基线族，单次可解）上打平是**预期**，不构成判负；
  只有 `dev-hard`（四种机制保证单次调用不可解）上也打平才判负。若只在 `dev-hard` 上有增益 ⇒
  这是**有效正结论**，声明范围写成"在单次调用不可解的任务上编排有增益"，并报四机制（超窗 / 高失败率 / 冲突约束 /
  不可逆首步）各自的分档增益——这比一个笼统的全域结论信息量更大。
  **即使全面判负，motif 两张表仍是产出**（搜索器在本域反复找到哪些结构、为何无增益），不允许以"没效果"收尾。
- **holdout 污染事故**（GA5 红）：① 标记该 holdout 版本作废 ② **重建新模板族** ③ 全部历史世代在
  新 holdout 上重跑（贵但必须）④ 账本留 `note` 记录事故范围。**不许**"只重跑受影响的部分"。
- **编码器版本事故**（`encoder_pin` 变更）：特征语义变 ⇒ 全历史控制层权重作废。处置：① 标记受影响世代
  ② 从受影响世代起在**新 `encoder_pin`** 下重训 + 重跑门禁 ③ 不可只重跑"看起来没事"的部分。
- **预算耗尽 ≠ 失败**：任务在 `B` 内未完成记 `incomplete`（与 `fail` **分开统计**），既进 `S@B` 的分母，
  也单独报 `incomplete_rate`；否则"提前停"与"做错"被混为一谈。
- **真 LLM 不可用**（下架 / 限流枯竭）：① **run 之间**走降级链（**run 内禁换模型**，只重试或作废）② 门禁与回归**全部回放到 stub**；live run 排队等配额。
  **不得**因端口不可用而降低门禁。
- **运行时自身也要 pin**：不只池 / 权重——`runtime` 进程代码、依赖锁文件、`exec` 沙箱镜像一律进 manifest。
  否则"回滚到旧 `ver`"只回滚了数据、没回滚执行体。
- **结论依赖的 run 必须可冻结**：任何被写进结论的 run 目录**只读**；后续重跑写新目录，旧的原地不动。
- **`sig` 口径变更事故**：`sig` 是去重键、motif 索引键、listwise 候选集去重依据。一旦口径变
  （如加同构规范化），**全历史去重键作废**。处置：① 标记受影响世代 ② 重建 motif 库与训练集去重索引
  ③ 重算 `family_sig` 分桶熵与 `Ei`（分桶变了 ⇒ 历史 `Ei` 不可比）④ 不可只重建"看起来受影响"的部分。
- **采纳窗口用尽**：`incumbent` 窗口最长 6 回合（受 `dev-hard` 约束：160 簇 / 每回合 25 簇 ⇒ `⌊160/25⌋ = 6`）。若用尽仍未判定（`h > δ` 持续），
  记"未判定并重开窗口"（换 `seed_window`、重新登记 group-sequential），**不得**降低 `n_min` 或抬高 `δ` 来强行判定。
  连续两个窗口用尽 ⇒ 触发 `δ` 的登记提案复议（写明可接受的最大退步），这是**唯一**允许改 `δ` 的路径。
- **`llm` 节点不可 memo 带来的成本上升**：相比"temperature=0 可短路"的旧口径，同契约同输入的 LLM 节点会真重复计费。
  这是刻意选择（防漂移被短路掩盖）。若 `redundant_step_rate` 因此持续超 `0.10`，处置是**改图设计**
  （把多路回答显式建模为扇出-聚合）或**降 `MAX_ANY_CAND`**，**不是**恢复 LLM memo。

---

## I · 细则

> 原则：**能由现有设计口径推出的，直接写死**（§I.1）；模板族目录在 §I.2；训练器落地在 §I.3。
> §I.1–I.3 是计划级实现规格，设计口径仍在四份设计文档。

### I.1 已定细则
**任务级验收器（形状已定；命令由模板规则解析进 task spec）**
- `verify(repo_state, task) = { pass@1, test_pass_fraction }`：在沙箱内跑 task spec 钉死的隐藏测试命令；
  `pass@1 = 1` 当且仅当**全部**隐藏测试通过（退出码 0 且测试报告无失败）；`test_pass_fraction = passed/total`
  （从测试报告解析，仅诊断）；**预算触顶 ⇒ 标 `incomplete` 但验收照跑**（`sink` 已产出合法产物时仍可能
  `pass@1=1`；未产出 ⇒ `pass@1=0` 且 `incomplete`）——"提前停但做对了"与"提前停且没做完"必须分开可见。
  **验收自身的执行成本不计入任务 `B`**（它是判卷不是做题），单列 `verify_cost`；
  但**验收的超时是硬上限**（`VERIFY_TIMEOUT`，住账本，默认 120s），超时 ⇒ `pass@1=0` 且记 `verify_timeout`
  （不记 `incomplete`——那是做题预算的概念，与判卷超时不同）。
  产物按 task spec 声明的路径白名单回写并哈希入 manifest；测试文件哈希须等于钉死哈希，否则任务分 0。
- **`verify` 在何时触发**：`sink` 求值完成后一次，或预算触顶收口后一次。**每任务每臂恰一次**，
  不允许"多跑几次取最好"（重跑次数入账，见 §G.1 如实红）。

**task spec 字段与模板校验**
- task spec（解析后、逐任务钉死）= `{ task_id, template_id, start_commit, description, difficulty_vector, budget_cap,
  hidden_test_cmd, artifact_paths[], expected[], test_file_hashes{} }`；`hidden_test_cmd` / `artifact_paths` / `expected`
  由模板的 `test_template` / `artifact_path_rule` 按参数示例**解析产出**（非手写逐模板清单）；生成器导出
  `bench-manifest.json` 供审计。
- **模板/任务校验（生成时全过才入池）**：① 隐藏测试在 `start_commit` 必红；② 在 oracle 解上必绿；
  ③ `test_file_hashes` == 钉死哈希；④ `artifact_paths` ⊆ 工作区白名单；⑤ 难度实测落档（见难度校准门禁）。

**`exec` 沙箱（形状已定）**
- 白名单 = 任务工作区根（realpath）∪ task spec 声明的产物输出路径；**逃逸判据** = 解析后的 realpath 落在白名单外、
  或经 symlink 跳出白名单、或试图写工作区外；默认无网（网络只在 `model` 端口）；超时 + 资源上限由子进程强制；
  越权 / 逃逸 ⇒ 任务分 0。
- **win32 落点**：realpath 须解析 reparse point / junction、统一盘符大小写与路径分隔符；check-then-use 的 TOCTOU 在执行边界二次校验 realpath（防符号链接在检查后被替换）。

**难度向量刻度（度量函数 + 校准门禁）**
- **六维** `{文件数, 接口数, 约束数, 不可逆步骤数, 隐含依赖数, 必读上下文量}`，每维取有序档 `1..5`；
  生成 = 模板 + 参数采样，模板声明各维可达区间；holdout 用**不同模板族**。
  第六维为 `dev-hard` 族新增（见 §I.2），`dev-lib` 族该维恒为 1–2。
- **度量函数（写死；只用 oracle 解读数，产物仍不入蒸馏、与 GA2 同口径）**：`f_files` = oracle 解改动/新增的文件数；
  `f_iface` = oracle 解新增/修改的函数/方法/类型签名数（AST diff）；`f_constraint` = task spec 显式声明的约束条数；
  `f_irrev` = oracle 解中不可逆操作数（删除 / 覆盖 / 迁移）；`f_implicit` = oracle 解必需、但任务描述未提及的模块/接口数；
  **`f_ctx` = ⌈(oracle 解必须读取的文件 token 总数) / `CTX_BUDGET`⌉ 落档**（`CTX_BUDGET` = 主档模型窗口 × 0.6，
  pin 进 manifest；换模型 ⇒ 该维全部重算，属 `encoder_pin` 级事故）。
- **锚点初值（住账本、可版本化；P2 随模板族定稿校准一次）**：档 `1..5` 依次为——
  `f_files` `1 / 2–3 / 4–6 / 7–12 / ≥13`；`f_iface` `1 / 2–3 / 4–7 / 8–15 / ≥16`；
  `f_constraint` `1–2 / 3–4 / 5–7 / 8–11 / ≥12`；`f_irrev` `0 / 1 / 2 / 3–4 / ≥5`；`f_implicit` `0 / 1 / 2 / 3–4 / ≥5`；
  **`f_ctx`（必读量/窗口比）`≤0.3 / 0.3–0.6 / 0.6–1.0 / 1.0–2.0 / >2.0`**。
- **校准门禁**：生成时校验 `f_d(task)` 落在模板声明的档位区间；一致率 < `theta.calib`（住账本，初值 `0.90`）⇒ 模板回炉、不得入池。
  dev / holdout 共用**同一锚点表**（跨集可比）。

**类型系统规范化**
- 兼容 = `type_id` 相等，或存在类型表 `subtypes` 偏序下的路径。`cardinality:'n'` 汇聚要求所有入边类型相等；
  否则先规范化到**最小公共超型**：在 `subtypes` 偏序中取所有入边类型的**最小上界**（least common ancestor）；
  不存在最小上界 ⇒ 汇聚类型不可满足 ⇒ `compile_reject(reason="merge_type")`。

**`role` 取值表与唯一匹配（禁止静默取首）**
- `role` 为 append-only 枚举（走 `declare{kind:'role'}`），初始 `{code, plan, critique, tests, patch, verdict, summary}`，可扩展。
- **`role_ok` 的判定（写死，三种情形）**：① 双方都声明 `role` ⇒ 必须相等（**不相等即非 `role_ok` 对，任何回退都不得放行**）；
  ② **只有一方声明** ⇒ **视为兼容**（不能因单方声明就拒，否则新增 role 会让既有契约互不可连）；
  ③ 双方都未声明 ⇒ 兼容。
  **唯一匹配的两阶段（写死）**：阶段一取"**双方都声明且相等**"的对，**恰一对 ⇒ 直接取它**；
  否则阶段二在**全部 `role_ok` 兼容对**中判，**恰一对才自动补齐**。分两阶段是为了让 `role` **缩小**歧义而不**制造**不可连；
  阶段二**不得**回落到"忽略 role 的全部类型兼容对"（那会放行双方声明但不相等的对，与 ① 冲突）。
- `LINK u→v` **唯一匹配** = 按上述两阶段后恰好一对 ⇒ 自动补齐。候选集**排除 `confidence` 旁路位**、
  排除已连满的入端口、排除已存在的同端口对。
  0 对 = 不可行（mask / 回退贪心）；>1 对 = 歧义 ⇒ **必须**显式端口对 `u:2→v:0`。
  **禁止**按端口编号或声明序静默取首（与《契约与图》「运行时确定性优先序更不可取」对齐；否则拓扑不再是唯一控制面）。
- **`entry_supply` 首节点绑定**：首节点 `required:true` 输入由 `entry_supply` 满足；恰好一项类型兼容（有 role 则再过滤）⇒ 绑定；
  0 或 >1 ⇒ `compile_reject(reason="entry_ambiguous")`，要求 task spec 显式端口映射。运行时按绑定注入，计入「已连接」（虚拟边）。

**子图等价规范化（结晶判定）**
- `sub_sig(sub) = H(canonicalJson({ nodes: 契约序列按首次生成序重标号, edges: 重标号后的 (i,out,j,in) 排序,
  boundary_inputs, boundary_outputs }))`；只含**诱导子图**、不含父图节点编号。结晶触发 = `sub_sig` 在 ≥ `k`
  个 dev 任务上任务级验收通过。`family_sig` 用于交叉域、`sig` 用于整图去重，三者不可混。

**motif 库（兼作实验的解释性产物）**
- motif = 池内既有子拓扑片段；入库键与去重键 = `sub_sig`；随池版本与图文法版本 pin；
  上限 `MOTIF_MAX=32`，触顶按使用频次淘汰（被淘汰的 `action_head` 列置零冻结、不复用）。
- **每条 motif 除结构外必须记这组统计（`declare{kind:'motif'}` 的 `body.stats`，每回合更新到派生表）**：
  `{ sub_sig, 契约多重集, |V|/|E|, 首次出现回合, 累计被选中次数,
     按难度档的任务级通过率（六维分档各一行）, 按族的通过率（dev-lib / dev-hard）,
     平均 cost_exec, 相对"同任务不含该 motif 的图"的通过率差 Δ_motif }`。
- **为什么这是架构件而不是报表**：现有产出只能回答「**是否**有增益」（配对 CI）与「**哪个因子**贡献」（五张分层表），
  答不出「**模型学到了什么结构**」。而 `Δ_motif` + 按难度档的通过率恰好把后者变成可报的表：
  「编排学到的是这几个 motif（critique-repair 回路 / 分片读-汇总 / 多方案-评判），它们在难度档 3–5 上把通过率抬了 X」。
- **最关键的性质：负结果下仍有产出。** 若主命题判负（编排无增益），motif 表依然回答
  「搜索器在本域反复找到哪些结构、它们为何没带来增益」——这是可发表的结构性观察，
  而不是只剩一句"没效果"。成本几乎为零（数据已在轨迹与 motif 库里），因此这是全部建议里性价比最高的一项。
- **必须报的两张 motif 表**（进每次 run 报告）：① **Top-`MOTIF_MAX` motif × 六维难度档的通过率矩阵**；
  ② **`Δ_motif` 排序表**（含 CI，按簇自助）。`Δ_motif` 为负的 motif 保留在表里——
  "搜索器偏爱但实际有害"的结构是 expert iteration 共退的直接证据，比熵指标更可读。
- **motif 表的数据来源 = 精英档案（§0.5-A / §G.26），不是全量轨迹**：档案里各行为桶的精英就是
  "在某个 `(|V|, 深度, cost, 契约多样性)` 区域里最好的那张图"，其 `sub_sig` 直接构成 motif 候选。
  这样 motif 表天然带**行为分档**（不必事后分桶），且与"防坍塌"共用同一份数据——**一处采集、两处受益**。
  **档案桶覆盖率**必须与 motif 表同页出列：覆盖率下降 = 搜索退化到少数行为区，此时 motif 表会系统性偏窄。

**契约数触顶（32）后的并入机制**
- 触顶后：新能力**并入既有契约**的 `role` / 子类型（扩展 `role` 枚举或新增 `inputs`/`outputs` 的子类型），
  不新增 `contract_id`；若无法并入 ⇒ 走「控制层容量」档（arch bump + 重训）。**禁止**静默突破专家数上限。

**能力缺口判定式**
- 缺口 = 某 `contract_id` 在 ≥ `N` 个 dev 任务上 `post` 通过率 < `theta.gap_rate`，**且**对该任务集合，
  在池内所有合法重连（同 `family_sig` 内的 EA 变异 + 有界 beam）下任务级验收通过率上界 < `theta.gap_repair`。
  满足才产出一条 `evidence_id`，才允许提案新增节点 / 契约。
- **"重连上界"的可负担性（写死，否则这条判定式跑不起来）**：穷举重连需要真跑验收，成本与 `N` 成正比、
  与"能力缺口"想省的成本同阶。落法：**上界用 `value_head` 估计 + 有界抽样核验**——
  ① 在同 `family_sig` 内枚举 EA 变异候选（受 `EA_POP` 限），用 `value_head` 打分取 top-`GAP_PROBE_K`
  （默认 8，住账本）；② **只真跑这 `GAP_PROBE_K` 张图**，取实测通过率作上界估计；
  ③ 若 top-K 中任一张通过 ⇒ 判"可重连修复"、**不产缺口证据**（宁可漏报也不误报，因为误报直接导致契约扩展）。
  代价（明写）：`value_head` 未训好时 top-K 可能漏掉真正可行的重连 ⇒ 误产缺口证据。
  补偿：缺口证据的动作是**提案**而非直接扩展，还要过生长额度与采纳闸；且 `GAP_PROBE_K` 与命中位次进报告，
  命中总落在末位 ⇒ `value_head` 排序无效，记诊断。

**金丝雀集抽样规则**
- 每契约 **pin 一张 canary 参考图** = 该契约节点在**首次任务级验收通过**的图中的**反向切片**（从该契约节点沿入边回溯到 `entry_supply` 边界，唯一确定；同一任务出现多图时取 `sig` 最小者）。参考图 pin 前该契约金丝雀统计记 `pending`（不进漂移判定）。参考图**只进金丝雀评估**、不进真实执行流与蒸馏。
- 每契约金丝雀集 = **固定 20 个 dev 任务**，在该参考图上跑，按难度向量分层抽样（各难度档至少 2 个、档数 `D ≤ 10`），**且 `entry_supply` 与该切片边界类型兼容**（不兼容的任务不得入该契约金丝雀集），pin 进池版本；统计按实例滚动（同一图 × 同一任务集 ⇒ 同契约各实例可比，GA11），Wilson 下界仅展示。health 落派生表，不进 `NodeDecl`。
- **`choose_instance`**：编排不输出实例 id。字典序 `(shadow 升序, success_lower_bound 降序, cost 升序, node_id 升序)`。影子或 `n=0` 时 `success_lower_bound=0`（**仅排序键置零**），排所有已转正之后。A/B 评估由 harness 强制指定实例，不走本规则、不经解码器。`success_lower_bound` = 实例滚动成功率的 Wilson 单侧下界（`alpha_lb` 住账本、默认 0.05），用于选择、影子转正与展示（转正比较用未置零的原始下界），不作漂移判定（漂移用 CUSUM）。

**bench 规模核算式（冻结池；P2 生成池时逐条断言）**
- **池形态**：P2 一次性生成并 pin 的**冻结任务池**（dev / holdout 两池，逐任务 spec 与哈希入池版本）；课程每回合从 dev 池**重采样** `ROUND_DEV_N`；金丝雀任务从 dev 池 pin。
- **记号**：`T_dev` 模板数、`V̄` 每模板可生成的不同参数示例数、`N_dev = T_dev·V̄`、
  **`C_dev` = 独立簇数 = `T_dev × |k_files| × |defect_site|`**、`E_max = 32`（契约数上限）、
  `s` = 任务跨契约金丝雀集的平均共享数、`D` = 难度档数。
- **约束**：① `N_dev ≥ ROUND_DEV_N + DEV_VAL_N`；② `N_dev ≥ ⌈20·E_max / s⌉`（worst-case `s=1` ⇒ `N_dev ≥ 640`；
  实注册 960 已满足）；
  ③ 各难度档任务数 ≥ `⌈2·E_max / s⌉`；④ `D ≤ 10`；⑤ **`C_dev ≥ 200`**（采纳闸的配对单位是簇，见 §I.2）；
  ⑥ holdout 独立族、`N_hold ≥ 200` 且 `C_hold ≥ 150`（检查点点估计用，预注册）；
  ⑦ 能力 oracle 走最强模型 + 长预算；构造 oracle 是生成器逆补丁，只用于入池与 `f_*`。
- **注册规模（§I.2）**：dev **两族** `dev-lib`（`T=20`）+ `dev-hard`（`T=10`），`V̄=32`
  （`k_files`4 × `defect_site`4 × `rename_seed`2）⇒ `N_dev=960`、**`C_dev=480`**；
  holdout 两族 `hold-pipe`（`T=10`）+ `hold-hard`（`T=6`）⇒ `N_hold=512`、**`C_hold=256`**；
  `D=5`（按**六维**档位之和的五分位，不是六维笛卡尔积）。
  不满足则加模板 / 加 `defect_site` 档，或回退 `E_max`，**禁止静默突破**；
  **禁止用加 `rename_seed` 的方式凑 `C_dev`**（换名不增独立信息）。
- **每回合 dev 批按族分层**：`ROUND_DEV_N=100` 取 `dev-lib` 50 + `dev-hard` 50（各 25 簇），
  窗口内跨回合不重复；两族各自的簇池（320 / 160）独立洗牌切批 ⇒ **窗口最长 `⌊160/25⌋ = 6 回合**（受 `dev-hard` 约束）。
- `s`、锚点终值与 `CTX_BUDGET` 在 P2 生成时实测回填；`T`/`V̄`/`N`/`C`/`D` 已注册，生成失败不得下调。

**`SharedRef` schema 与 join 合并**
- `SharedRef = { key, type_id, scope:'task', supply_cost? }`（`supply_cost` = 该键的四维供给先验，初值按同键在 dev 上的实测 p90 回填、随池版本 pin；改它 = 新池版本 + 记账）；键表 append-only（`declare{kind:'shared_ref'}`）。互斥 OR 分支的跨分支合并：
  `join` 契约声明 `inputs` 为各分支产物（`binding_mode:'all'` + `cardinality:'n'` + `required:false`——
  互斥分支下只有一条会有产物，故不能 required）、`outputs` 为合并键。
- **合并规则（写死，`producer.step` 不可用作判据）**：按 `type_id` 分派——
  `artifact` 走用户声明的 `merge` 合并器，**无声明时取"入边中 `node_index` 最小的已产出者"**；
  `verdict` 取 `vote`（平票取 `node_index` 最小者）；`prob` 取加权平均（权重 = 各分支 pin 住的先验，默认等权）。
  **不用 `producer.step`**：拉式惰性下 `step` 是执行顺序计数器，互斥分支中只有一条会执行 ⇒ `step` 无可比性；
  且若将来并行化，`step` 不再确定。`node_index` 由拓扑唯一确定，任何执行顺序下都一致。
  规则住账本、可版本化；下游只读 join 之后的版本。

**MoE 负载均衡损失**
- Switch-style：`L_aux = α · E · Σ_e f_e · P_e`（`f_e` = 专家 e 被 gate 选中的 token 比例，`P_e` = gate 给 e 的
  平均概率，`E` = 专家数）；默认 `α = 0.01`（住账本），计入 MDL。

**飞轮停轮阈值与数据保留**
- 停轮 = 连续 `WINDOW` 回合满足任一：正样本产出率 < `theta.pos_rate`、`Ei` 单调下降、训练集分布漂移
  （难度 / 契约 / `|V|` 的 PSI）> `theta.drift`。停轮即诊断，不硬转。训练集用**滑窗**（保留最近 `TRAIN_WINDOW`
  回合）+ 内容寻址去重；淘汰记 `note`。

**L1 可选 `reads` 供给协议**
- 契约 `reads` 可标 `optional:true`；节点发 `request_input(key, need)`，运行时先查 `key ∈ reads`
  （否则拒绝并记 `refusal(undeclared_read)`），再按剩余预算 `supply` 或 `refuse(budget)`；每次握手记
  `input_request` 事件（算「新信息」，避免 L1 请求被误判 `wasted_step`）。**不得**运行时动态请求未声明键。

**池不变量（P1 校验）**
- 至少一个只依赖 `'artifact'` 的 `touches_effects:false` 契约（兜底首节点）。
- 至少一个 `join` 契约（跨互斥 OR 分支 publish 合并）。
- 无输入端口的契约只能出现在首位；非首位 mask。
- `delegate_reads ⊆ reads`；`canary_set` 在 Contract 上；health 不进 NodeDecl。

**`put(slot='binding.*')` 与 `bindings.*`**
- 单一 op `put{ slot, def_ref }` 覆盖全部八个绑定槽
  （`prompt` / `model` / `decoding` / `tools` / `context_policy` / `retry_policy` / `weights` / `subgraph`）；
  `slot` 全名带前缀（`binding.prompt` / `binding.retry_policy` / …），与 `slot='threshold'` 同表区分。
- 同一份 def：`bindings.<slot>` 持 pin，`put(slot='binding.*')` + `set_active` 切 active 版本。不是第二份副本。
- **绑定变异（不占生长额度）的全部落点就是 `put(slot='binding.*')`**——换模型、换 `temperature`、换工具版本都在此；
  旧 op 表只给了提示词与策略两个 slot，模型 / 解码 / 工具 / weights 无处入账，这是补齐的原因。
- 路由选边是模型前向，不走 `put(slot='binding.*')`；控制层三模型权重走 `add_ver` / `set_active`（世代通道），
  只有 `trainable` **节点自身**权重走 `put(slot='binding.weights')`。

**课程默认（采样规则必须与累计窗口配套，否则 n 永远攒不够）**
- 默认 = 对冻结 dev 池**按簇均匀采样、按族分层、窗口内跨回合不重复**（without replacement across rounds）：
  每个 `incumbent` 窗口开始时用 `mulberry32(seed_window)` 把两族簇池（`dev-lib` 320 / `dev-hard` 160）
  **各自确定性洗牌**，按回合顺序切成不重叠批次（每回合 25 + 25 簇 = 100 任务）；窗口内第 r 回合取第 r 个批次。
  **窗口最长 `⌊160/25⌋ = 6 回合**（受较小的 `dev-hard` 池约束；用尽则该窗口强制判定或宣告"未判定并重开窗口"，
  重开时换 `seed_window`）。
- **为什么不能"每回合独立重采样"**：独立重采样下 4 回合只覆盖约 157 个**不同**簇
  （`480·(1−(1−50/480)^4)` 同量级），永远攒不到 `n ≥ 200`，group-sequential 的信息累积前提也不成立。
  跨回合不重复 ⇒ 4 回合恰好 200 个不同簇（50 簇/回合 × 4），第 4 回合起可判定。
- **分层是必需的**：若不按族分层、直接在 480 个簇里均匀采，各回合两族比例会随机波动 ⇒
  逐回合 `S_dev` 混入族构成差异（两族基线成绩差很大），曲线不可读。
- **代价（明写）**：窗口内各回合的 dev 批不同 ⇒ 逐回合 `S_dev` 曲线含批次难度差异。
  补偿：曲线报告用**窗口内累计** `S_dev`（并标注累计簇数），逐回合值只作诊断；
  批次难度差异由确定性洗牌 + 分层（各批次难度档比例与全池一致）压到最小。
- 非均匀调度须有覆盖缺口证据并登记；非均匀档下**仍须保证窗口内不重复**，否则采纳闸无法判定。

**两类 oracle（不可混）**
- **构造 oracle** = 生成器种植变异的逆补丁（随模板产出，确定性）。只用于入池校验 ①② 与 `f_*` 计数。**不**当作 GA2 可解比例（否则合成任务 GA2 恒 1，门禁作废）。
- **能力 oracle** = 最强模型 + 长预算（GA2）；产物写 `runs/oracle-<stamp>/` 只读，**不接入蒸馏**；`producer == oracle` 入库直接拒。`f_*` 只读构造 oracle，不读能力 oracle。

**`compile_reject` schema 与告警线**
- `compile_reject = { task_id, graph_sig, reason ∈ {publish_order, merge_type, missing_join, entry_ambiguous}, detail, step }`；
  `type_mismatch` / `limit` / `acyclic` 属于语法层，出现即解码器 bug、GA1 红，**不是** `compile_reject`。
  告警线 `compile_reject_rate > 0.10`（住账本）⇒ 记诊断、作为"生成器没学会约束"的升级证据候选，**不计入 GA1**。

**进展强制（两段）判定式**
- **执行前 `redundant_reject`**（不调度、不计费）：同键第二次调用且未递增 `variant_index`；或本 `(node_index, step)` 已调度。幂等节点由 memo 先短路。
- **执行后 `wasted_step`**（已执行、按实测计费）：无新 slot 内容且无新信息。新 slot 内容 = 写了未被 memo 命中的 artifact 且与该 slot 历史版本**逐字节不同**；新信息 = `verdict` / 拒绝码 / `edge_choice` / `input_request` / `autonomy_decision` 与该 `(node_index, step)` 历史**不同**。
- **DAG 下只在 L1 重试与 `composite` 内部触发**（外层节点首次执行必有新信息）⇒ `wasted_budget_rate` 实质是 **L1 空转率**，报告须标注。
- `redundant_step_rate` 含两段；`wasted_budget_rate` **只含** `wasted_step` 消耗。

**字段级 schema（最小版，P0 内细化）**
- `Entry = { seq:int, prev:hash, op:enum, args:object, argsHash:hash, by:string, ref?:hash, at:int }`（已对齐内核）。
- trace 一等事件**分三张表**（作用域不同，见《契约与图》§2.2 事件表；均不入 defs 链）：
  - 执行流 `{ run_id, task_id, step, type, node_index?, instance_id?, payload, at }`，按 `(run_id, task_id, step)` 追加；
  - 生成流 `{ run_id, task_id, decode_seq, type, payload, at }`，按 `(run_id, task_id, decode_seq)` 追加
    （`decode_fallback` / `decode_stop_kind` / `greedy_completion` / `think_stop` / `compile_reject` / **解码期 `incomplete`（`reason ∈ {closure_budget, closure_budget_or_sink, no_legal_token}`）** 发生在图存在之前，无 `step`/`node_index`；任务级 `incomplete` 归执行流表——同名双作用域，以所在表区分）；
  - 搜索流 `{ run_id, round, rollout_seq, type, payload, at }`，按 `(run_id, round, rollout_seq)` 追加
    （`invalid_crossover` / `gate_k_shrink`，属回合级 `search_cost` 记账面，不进单任务轨迹）。
  **三表不可合并**：合并会让 `step` 语义漂移，按 `step` 聚合的 `wasted_step` / `redundant_step_rate` 全部算错。
- 证据：`Evidence = { evidence_id, kind ∈ {drift, failure_cluster, coverage_gap, budget_anomaly, capability_gap, crystallization_candidate}, target, stat,
  threshold, window, created_at }`。
  **`failure_cluster` 的 `target` 必须是 `{ refusal_code, attributable_to }`**（不是 `contract_id`）——
  聚类要跨契约可比，否则"缺什么能力"问不出来（见《进化与账本》§一 聚类说明）。
  **`capability_gap` 的 `target` = `contract_id`**（它按契约定位），但产它之前必须先看失败聚类的
  `attributable_to`：若失败主要归 `graph`（编排选错），应改提示词/池统计，**不产 `capability_gap`**。
- 提案：`Proposal = { proposal_id, type ∈ {binding, instance_growth, contract_ext, crystallization}, evidence_id,
  target, expected_gain, payload, created_at }`；缺 `evidence_id` 直接拒。
- **被拒提案必须回灌 manager 输入（借自 Procedural Graphs，§0.1）**：manager 每回合的输入除证据外，
  必须含**近期被拒提案的清单**（`proposal_id` + `type` + `target` + 拒绝原因），
  否则 manager 会反复提同一条被拒提案——原设计只记了拒绝，**没有让拒绝影响后续提案**，这是缺口。
  判据：**同 `(type, target)` 的提案连续被拒 ≥ `REJECT_REPEAT_MAX`（住账本，默认 2）⇒ 本回合该提案直接拒并记
  `evidence_id(kind='repeat_rejected')`**，manager 必须换方向或补充新证据。
- 训练样本：`{ sample_id, task_id, producer ∈ {search, teacher, exec}, graph_sig | sub_sig, target_dist?,
  dense_labels?, trace_ref, pool_ver, weight_ver, prompt_ver }`；四闸判定式 = 对抗套件通过 ∧ 泄漏扫描无命中 ∧
  内容寻址去重无命中 ∧ 回灌下逐字节可重放。

### I.2 模板族内容（已定稿；P2 按此生成）

> 方法在 §I.1。本节给出**两族目录 + 共享生成规则 + 注册规模**。P2 生成时只回填实测 `s` 与锚点终值；`T`/`V̄`/`N`/`D` 不得下调。

**注册规模**

| 池 | 族 | T | V̄ | N | 独立簇 | 骨架 |
|---|---|---|---|---|---|---|
| dev | `dev-lib` | 20 | 32 | 640 | **320** | 库风格：`src/index.ts` + `src/lib/*.ts` + `src/types.ts` |
| dev | **`dev-hard`** | **10** | **32** | **320** | **160** | **单次调用不可解族**（见下） |
| holdout | `hold-pipe` | 10 | 32 | 320 | **160** | 管线风格：`src/pipeline.ts` + `src/stages/*.ts` + `src/ir.ts` |
| holdout | **`hold-hard`** | **6** | **32** | **192** | **96** | **单次调用不可解族的 holdout 骨架**（不同 IR，不换语言） |
| val 切片 | ⊂ dev | — | — | `DEV_VAL_N=64` | 32 | 分层钉死，不进搜索/蒸馏；**两族各半** |
| **探针** | **`probe-real`** | **6** | **8** | **48** | — | **迁移探针：真实开源 PR 反向构造；明标污染、不进主命题**（见下） |

> **`probe-real` 不进上表的规模核算**（`N_dev`/`N_hold`/`C_dev`/`C_hold` 都不含它），
> 它不参与 `ROUND_DEV_N` 采样、不进 `DEV_VAL_N`、不进 holdout 判定、不进训练集。

**`dev-hard` / `hold-hard`：单次调用不可解族（新增，直接关系主命题能否立起来）**

现有 `dev-lib` 是**单点缺陷修复**（缺 export / 少 await / 空 catch / 循环边界），`f_files ≤ 5`。
这类任务**一次强模型调用大概率能做对** ⇒ GA8① 单节点臂逼近自适应臂 ⇒ 「编排有增益」当场塌。
而 GA2 又要求 oracle 可解率 ≥ 0.80，即天花板本来就低、两臂之间空间很窄。
问题的根子是：任务域按**便宜 + 可判分**选的，不是按**需要编排**选的。故新增一族，**结构上**让单次调用做不到：

| 机制 | 怎么让单次调用不可解 | 对应自变量 |
|---|---|---|
| **A. 上下文超窗** | 必须读的代码量 > `CTX_BUDGET`（住账本，默认 = 主档模型窗口的 60%）⇒ 一次调用装不进全部必要信息，必须**分解 + 分片读** | 分解 |
| **B. 高单步失败率** | 变换本身易错（嵌套模板展开、IR 降级），单次通过率经 oracle 实测 < 0.35 ⇒ 必须 **critique → repair 回路** | 编排（OR 分支 + 聚合） |
| **C. 冲突约束** | 两条以上约束互相拉扯（性能 vs 可读性 vs 兼容旧 API），需**显式权衡并择一** ⇒ 必须多方案 + 评判 | 编排（扇出-聚合） |
| **D. 不可逆首步** | 第一步选错后续全废（选错数据结构 / 选错迁移顺序）⇒ 必须**先规划再动手** | 分解 / 规划 |

**每族 10 个模板按 A/B/C/D 各 2–3 个**，`V̄=32` 沿用 `k_files(4) × defect_site(4) × rename_seed(2)`。
`hold-hard` 6 个模板覆盖同四类机制但换骨架（不同 IR 形状），仍过 `theta.ast_sim` 族间扫描。

**四条硬约束（否则这族会引入新的混淆）**：
1. **仍必须 oracle 可解**：`SOLVABLE_MIN=0.80` 对**每族分别**成立（不是合并后成立），否则「不可解」会被误读成「编排无效」。
   A 类的 oracle 用**长预算 + 允许多次调用**（这正是它与单节点臂的差别所在）。
2. **`CTX_BUDGET` 必须 pin 进 manifest 并作为难度向量的一维**——它依赖模型窗口，换模型会让 A 类任务变质。
   故**难度向量从五维扩到六维**：`{文件数, 接口数, 约束数, 不可逆步骤数, 隐含依赖数, **必读上下文量/窗口比**}`，
   第六维 `f_ctx = ⌈必读 token 数 / CTX_BUDGET⌉` 分 5 档（`≤0.3 / 0.3–0.6 / 0.6–1.0 / 1.0–2.0 / >2.0`）。
   **`f_ctx ≥ 3`（即 > 窗口 60%）才算 A 类**。
3. **单节点臂不豁免、不放宽**：它照样只能用 1 次调用、同一 cap。**如果它在 A 类上因超窗而失败，那正是要测的结论**，
   不是不公平——「同预算下编排能否用好预算」本来就是命题。
4. **两族必须分开报**：主表按 `{dev-lib, dev-hard}` 分栏。**预期结果不同**：`dev-lib` 上编排增益可能接近 0
   （这没问题，它是对照基线），`dev-hard` 上若仍为 0 才是真负结果。
   **主命题的判定以两族合并的簇级配对为准，但必须同时报分族结果**——只在 `dev-hard` 上有增益是**有效结论**
   （"编排在需要编排的任务上有增益"），只需把声明范围写准（§H.1 的"缩小声明"机制正是为此）。

> **代价与连锁（明写）**：① 模板工作量 +16 个模板（30→46，约 1.5× 于原计划）；② dev 池 640→960 任务 / 320→480 簇
> ⇒ 每回合 dev 批仍取 100 任务但**按族分层**（各 50），窗口最长仍 6 回合；③ A 类任务的单任务 token 成本更高
> （必读上下文大）⇒ per-task cap 需按族区分：`dev-hard` 的 `tokens` cap 取 `120_000`（2× 基线），
> 其余三维不变，pin 进 task spec；④ 全实验 token 与成本估算随任务量上修（dev 池 640→960，**绝对值不在此重复登记**，统一按 §G.22 口径重算并在 P2 定稿时回填）。

> **holdout 只做点估计非降（`ε` 判据），不做 CI 检验** ⇒ 160 簇够用；核算式 ⑤ 的"`N_hold ≥ 200`"改口径为
> **`N_hold ≥ 200` 任务且独立簇 ≥ 150**（点估计的标准误在 160 簇下约 0.04，与 `ε=0.02` 同阶，
> 故检查点 holdout 判据须**报点估计 + 簇级自助 CI 供参考**，硬条款仍只是点估计非降）。
> **val 切片按簇钉死**：`DEV_VAL_N=64` 任务 = 32 个完整簇（不切开簇，否则同簇一半在训一半在验 = 泄漏）。

**`V̄=32` 的共享参数轴（每模板相同，保证规模）**：
`k_files ∈ {2,3,4,5}` × `defect_site ∈ {0,1,2,3}` × `rename_seed ∈ {0,1}`。

- `k_files` 驱动 `f_files` / `f_iface`（实例化几个模块）。
- **`defect_site`** = 该模板的缺陷种植在**第几个模块 / 第几处结构位点**（`site = defect_site mod k_files` 选模块，
  模板内再按声明的位点表选具体位置）。**不同 `defect_site` ⇒ 起始状态、隐藏测试触发路径、逆补丁都不同 ⇒
  `f_implicit` / `f_irrev` 与解法均不同**，是**结构变体**而非换名副本。
- `rename_seed` 只改标识符、不改 `f_*` 与解法（记忆化探针，保留 2 档）。

**统计独立单位（写死，堵"640 当独立样本"）**：**独立簇 = `(template_id, k_files, defect_site)`**，
`20 × 4 × 4 = 320 簇 ≥ 200`；同簇内 2 个 `rename_seed` 任务是**换名重复**，
**配对检验的配对单位是簇**——同簇两个任务的结果先聚合成该簇的成功比例（0 / 0.5 / 1），
再按簇做配对非劣检验，`n` 取**簇数**不取任务数。
把 640 当独立样本会让 CI 系统性过窄、假阳性；这条须在 §G.3 与 §G.1 的统计口径里一致执行。
`rename_seed` 两档间的差异单列 `rename_variance`（同解法不同标识符的成绩差 ⇒ 记忆化 / 表面形式敏感性诊断）。

`D=5`：以**六维**档位之和的五分位分桶；各档 ≥ `⌈2·E_max / s⌉` 在 `s=1` 时 = 64，960/5=192，满足。
**难度声明区间按 `(template_id, k_files, defect_site)` 声明**（不是只按 template），校准门禁逐簇判。
**分桶在两族合并后算**（否则两族各自的五分位不可比），但报告按族分栏出 `S_dev`。

**共享规则（两族同一套，路径不同）**
- 语言 / 测试：TypeScript + vitest；`hidden_test_cmd = node <pinned>/vitest.mjs run --reporter=json ${hidden_test_file}`。
  **不用 `npx`**：`npx` 会尝试联网解析包（沙箱默认无网 ⇒ 每次失败重试拖满超时），且解析到的版本不确定
  （破坏"运行时 pin"）。落法：`node_modules` 与 vitest 版本随**沙箱镜像 pin**，`hidden_test_cmd` 直接调
  pin 住的可执行入口；镜像哈希进 manifest。
- `artifact_path_rule`：dev = `src/lib/**/*.ts` ∪ `src/index.ts` ∪ `src/types.ts`；holdout = `src/stages/**/*.ts` ∪ `src/pipeline.ts` ∪ `src/ir.ts`。测试文件不在产物白名单内（防改测试）。
- **生成管线**：① 从干净骨架实例化 `k_files` 个模块并 `rename_seed` 换名 → ② 按模板种植变异（broken = `start_commit`）→ ③ 写出隐藏测试（干净必绿、broken 必红）→ ④ **构造 oracle** = 逆补丁（生成器保留）→ ⑤ 算 `f_*`、对声明区间做校准 → ⑥ 导出 `bench-manifest.json`。
- 入池五检全过才留；失败的 `(template, seed, k_files)` 换 seed 重试，**不得**用减 `V̄` 凑数。整模板校准一致率 < `theta.calib` ⇒ 模板回炉。
- **能力 oracle**（GA2）另跑，不参与入池、不入蒸馏。
- **族间泄漏**：每个 holdout 模板 vs 每个 dev 模板算 token-type bag 余弦，任一 ≥ `theta.ast_sim=0.60` ⇒ 该 holdout 模板拒。同族内部允许相似。
**`token-type bag` 的口径（写死，否则阈值不可复算）**：对模板的**干净骨架 + 隐藏测试**做 TS 解析，
取 **AST 节点 kind 的多重集**（`SyntaxKind` 名，不含标识符字面量、不含注释、不含字符串内容），
按 kind 计数向量做 L2 归一后算余弦。**标识符必须排除**——否则 `rename_seed` 会影响相似度、
而它本应与语义无关。阈值 `0.60` 是**同语言不同族**的经验分界：两族都是 TS + vitest，
公共语法骨架（import / describe / it / expect）本身就贡献约 0.35–0.45 的余弦，
故 `0.60` 是"结构习惯明显撞车"而不是"语言相同"。**P2 生成时必须报实测的族间余弦分布**；
若 `hold-pipe` 全部模板都在 0.55–0.60 之间贴线通过，说明两族结构区分度不足 ⇒ 重设计 holdout 骨架，
**不得**上调阈值。

**`dev-lib`（20，基线族）**：库编辑。列「可达档」= 该模板声明的六维区间（未列维默认 1–2，靠 `k_files` 拉 `f_files`/`f_iface`；
该族 `f_ctx` 恒 1–2，这正是它"单次调用可解"的原因）。

| id | 种植的缺陷 | 主要维可达档 |
|---|---|---|
| `export-gap` | 缺 named export | iface 1–2, constraint 1–2 |
| `type-widen` | 返回类型过窄 | iface 2–3, constraint 2–3 |
| `rename-miss` | 跨文件部分重命名 | files 2–4, implicit 1–2 |
| `dead-default` | 错误默认参数 | constraint 1–2 |
| `async-race` | 缺 await | irrev 1–2, implicit 1–2 |
| `error-swallow` | 空 catch | constraint 2–3 |
| `off-by-one` | 循环边界 | constraint 1–2 |
| `map-key` | 对象键名与类型不一致 | iface 2–3, constraint 2–3 |
| `null-guard` | 缺空值检查 | constraint 2–3, implicit 1–2 |
| `api-migrate` | 仍走旧 API | files 2–4, iface 3–4, irrev 2–3 |
| `layer-leak` | 越层引用 internal | constraint 3–4, implicit 2–3 |
| `schema-drift` | 解析器与类型声明分叉 | iface 3–4, constraint 3–4 |
| `multi-file-feat` | 多文件功能只做了一半 | files 3–5, iface 3–5, implicit 2–3 |
| `test-dup-impl` | 双份实现一份过期 | files 3–4, irrev 2–3 |
| `invariant-break` | 文档不变量未维持 | constraint 4–5, implicit 2–4 |
| `config-merge` | 深层合并覆盖错 | files 2–4, irrev 2–3, constraint 3–4 |
| `cache-stale` | 失效条件缺失 | implicit 3–4, irrev 2–3 |
| `enum-exhaust` | switch 缺分支 | iface 2–3, constraint 2–4 |
| `path-join` | 字符串拼路径 | constraint 1–3, implicit 1–2 |
| `idempotent-retry` | 重试重复施加 | irrev 3–4, constraint 3–4 |

**`hold-pipe`（10）**：IR/管线变换（与库编辑不同的 AST 习惯：stage 函数、IR 节点、pipeline compose）。

| id | 种植的缺陷 | 主要维可达档 |
|---|---|---|
| `tokenize-shift` | token 边界 off-by-one | constraint 2–3 |
| `ast-rewrite` | visitor 漏节点类型 | iface 3–4, implicit 2–3 |
| `cfg-compile` | 配置 DSL 降错 IR | files 3–5, iface 3–4, irrev 2–3 |
| `table-norm` | 列对齐 / 空单元格 | constraint 3–4 |
| `graph-topo` | 拓扑排序遇环未拒 | constraint 3–5, implicit 2–3 |
| `template-expand` | 占位符嵌套展开顺序 | irrev 2–3, implicit 3–4 |
| `csv-join` | 多流 join 键不一致 | files 3–4, constraint 3–4 |
| `ir-lower` | 高层 IR 降级丢语义 | iface 4–5, irrev 3–4, implicit 3–4 |
| `sched-order` | stage 依赖顺序颠倒 | constraint 4–5, irrev 2–3 |
| `diff-apply` | patch hunk 上下文漂移 | files 3–5, irrev 3–5, implicit 2–4 |

**`dev-hard`（10，不可解族）与 `hold-hard`（6）**：按四机制分配模板，每模板声明所属机制与六维可达档。

| 机制 | dev-hard 模板（示例 id） | 单次调用为何不可解 | 主要维可达档 |
|---|---|---|---|
| **A 超窗** | `wide-refactor`、`cross-module-contract`、`config-sprawl` | 必读代码量 > `CTX_BUDGET` ⇒ 装不进一次调用，须分片读+汇总 | `f_ctx` 3–5, files 4–5, implicit 3–4 |
| **B 高单步失败率** | `nested-template`、`ir-lower-hard` | 变换本身易错（oracle 实测单步通过率 < 0.35）⇒ 须 critique→repair 回路 | constraint 4–5, irrev 3–4 |
| **C 冲突约束** | `perf-vs-compat`、`api-deprecation` | 两条以上约束互相拉扯，须显式权衡择一 ⇒ 须多方案+评判 | constraint 4–5, iface 3–4 |
| **D 不可逆首步** | `datastruct-choice`、`migration-order`、`schema-evolve` | 首步选错后续全废 ⇒ 须先规划再动手 | irrev 4–5, implicit 3–4 |

`hold-hard`（6）覆盖同四机制（A2 / B1 / C1 / D2）但换骨架形状，仍过 `theta.ast_sim` 族间扫描。

**P2 回填（生成后 pin）**：实测 `s`；**六维**锚点终值（初值见 §I.1，一致率 ≥ `theta.calib` 才许改）；
**`CTX_BUDGET`**（= 主档模型窗口 × 0.6，`f_ctx` 依赖它）；各族的 oracle 可解率与**单次调用可解率**；
`bench-manifest.json` 哈希。不得回填更小的 `T`/`N`。

**`probe-real`：迁移探针族（已采纳；明标污染、绝不进主命题）**

- **目的**：检验 P5 训练好的控制层能否从 toy 域迁移到"真实感"域——即 §G.25 的落差②（池规模）与③（特征面），
  以及变体②要测的落差①（验证器）。
- **与四个主族的本质差别：它必然被污染**。任务是真实仓库的真实改动 ⇒ **几乎必然在预训练集里**。
  因此它**绝不进主命题、不进训练集、不进 holdout 判定**，只用于回答"方向是否一致"。
  **报告里必须与主表物理隔离**（独立小节 + 页首告警），否则读者会把污染数据当证据。
- **构成**：
  - **真实感契约池**：不是 toy——带真实提示词（长、含角色/约束/示例）、真实工具绑定、真实错误模式；
    契约数仍 ≤ 32（受专家维度上限约束），但每个都"像生产里的插件"。
  - **接近真实的仓库**：更大、更脏、有无关文件、有既有测试、风格不一致；`f_ctx` 3–5 档。
  - **任务构造**：从真实开源 TS 仓库的**已合并 PR** 反向构造（取 PR 前的 commit 状态 + PR 自带的测试作为验收）。
- **规模**：6 模板 × 8 变体 = 48 任务（小规模，只为看方向，不做统计判定）。
- **两个变体（都必须跑）**：
  - **变体①（域迁移）**：完整自动验证（用 PR 自带测试）。跑 2 臂（自适应 vs 固定图）× 1 seed × 48 任务，
    看**差值方向与量级是否与主命题一致**。
    一致 ⇒ 落差②③ 标"实验内已验证"；不一致（差值归零或反号）⇒ 标"需生产重验"**并在 P5 报告里显式告警**。
  - **变体②（弱监督，测落差①——最深的一条）**：**把任务级验证从搜索中遮掉**，只留节点级 `post` 作搜索信号，
    最终判定时才用隐藏测试。看**蒸馏出的控制层是否仍优于固定图臂**。
    通过 ⇒ "飞轮在无任务级验证时仍可工作"成立，落差① 降级为"需生产重验但方向乐观"；
    不通过 ⇒ 落差① 标"**已知不可转移**"，并**必须给出替代监督源的登记提案**
    （LLM-judge / 人评 / 弱标签 / 偏好学习四选一），否则生产侧无解。
- **判据只报方向，不报显著性**（48 任务、1 seed，n 太小）——这是**探针不是实验**，措辞必须写明。
- **成本**：两个变体合计 ~200 次执行 ≈ $3–10。**成本不是问题，隔离与措辞是问题。**

### I.3 训练器落地（已写死；改动走提案）

**TS 前向 ↔ Python 逐 bit 一致**
- 参考前向与语言无关：float32、禁 tf32 / 融合 matmul / 非确定 BLAS；`C[i,j] = Σ_k A[i,k]·B[k,j]` 按 `i,j,k` 升序累加。
- TS 与 Python 各自实现同一套层；F1 fixture（pinned 输入 + `weights.json`）逐层激活哈希与最终 logits **逐 bit 相等**，不等即红。
- 训练只在 Python；导出 `weights.json`（arch + f32 小端、canonicalJson）；TS 只加载推理。往返 = Python 前向 vs 导出后 TS 前向，同一 fixture。
- 特征单源：白名单特征的 TS 实现是唯一生产者，Python 读同一规范化向量，禁止两边各算一遍。

**训练超参**（默认见 §G.18，住账本）
- AdamW；`τ=1.0` 固定（不退火）。早停：`DEV_VAL_N=64` 的 listwise 连续 `patience=5` 无提升，或 `max_epoch=50`。
- `DEV_VAL_N` 从冻结 dev 池分层钉死，**不进搜索 / 蒸馏**；可与金丝雀重叠（都是评测向）；**不进 holdout**。
- 规模：`N_dev=960 ≥ ROUND_DEV_N + DEV_VAL_N`（100+64），不改核算式下限。

---

## J · 关键算法与伪代码（实现）

> `B` / `C` / `D` 的口径在此给出实现伪代码（J.1–J.16）。`bootstrap_bca_ci`（采纳闸，按簇）、
> `wilson_ci`（单臂 pass@1 的展示性 CI）、`common_supertype_exists`、`dedup_hit`、
> `adversarial_suite_pass` 等判定已由 §I.1 定义；§I.2 模板族已定稿，P2 生成时只回填实测 `s` 与锚点终值。

### J.1 受约束解码（mask / 回退 / 补齐）

```
# st = { nodes: [contract_idx...]（顺序即拓扑序）, edges: [(i,out_port,j,in_port)...] }
# depth(entry)=0；depth(v)=1+max depth(pred)；无入边的非首节点非法
# contracts：端口按声明序 0..k-1；compat：type_id 相等或 subtypes 偏序下可达
# entry_supply：任务 spec 的 typed 供给；首节点 required 由虚拟边满足，计入 connected
# 闭合 = required 全连 ∧ 非首节点≥1入边 ∧ all_reach_sink ∧ |V|≥1
# THINK 前缀见 J.13；本函数从 THINK_STOP 之后的图 token 开始

connected(st, v, p):
  if v == 0 and required(p) and exists s in entry_supply with unique_or_bound(s, p):
    return true                                          # entry 虚拟边
  return exists edge (_, _, v, p) in st.edges

unique_match(i, j):                                    # 两阶段，与 §I.1 role 口径一致
  pairs = role_ok(type-compatible port pairs (i→j))     # 双方声明须相等；单方/均未声明视为兼容
  strict = both-ends-declare-and-equal subset of pairs
  if |strict| == 1: return that pair                    # 阶段一：双方声明且相等恰一对
  if |pairs| == 1: return that pair                     # 阶段二：role_ok 兼容对恰一对
  return null                                           # 0 或 >1：不可静默取首；禁止回落忽略 role

simulate_closure(st):                                    # 与 complete_greedy 同一选择规则
  t = copy(st)
  # 阶段一：补 required 入边。按 (v 升序, p 声明序) 遍历，保证确定性
  for v in ascending(t.nodes), p in declared_order(inputs(v)):
    if not required(p) or connected(t, v, p): continue
    # 候选前驱：下标 < v、输出端口类型兼容、且该输入端口未连满
    cand = min{ (i, op) : i < v, compat(out_type(t,i,op), p.type),
                          role_ok(out_role(t,i,op), p.role) }        # 按 (i, op) 字典序取最小
    if cand == null or len(t.edges) >= MAX_EDGES: return null
    t.edges.push((cand.i, cand.op, v, p))
    if max_depth(t) > MAX_DEPTH: return null
  # 阶段二：补 sink 可达。sink = 生成序最后一个节点（唯一，见《契约与图》§二不变量 3）
  sink = last_index(t.nodes)
  for v in ascending(t.nodes):                            # 升序保证：修 v 时其后继链已可达或稍后被修
    if v == sink or reaches(t, v, sink): continue
    # 目标 = 下标 > v 中最小的、有兼容入端口且未连满的节点；退化到 sink
    tgt = min{ j > v : exists (op, ip) with compat(out_type(t,v,op), in_type(j,ip))
                        and in_degree(t,j,ip) < cardinality_max(j,ip) }
    if tgt == null: return null                           # 含"sink 无空闲兼容入端口"的情形
    if len(t.edges) >= MAX_EDGES: return null
    t.edges.push(min_compat_pair(t, v, tgt))              # (op, ip) 取字典序最小
    if max_depth(t) > MAX_DEPTH: return null
  if len(t.nodes) < 1 or not all_reach_sink(t): return null
  if not acyclic(t): return null                          # i<j 已保证，此处是 assert 性质
  return t

# 三处原缺陷已修：
# (a) 原 while 循环无确定性遍历序 ⇒ 同一 st 可能产出不同补齐结果。改为按 (v,p) 升序 for。
# (b) 原「min{ i<v : compat(...) }」只取节点下标、未取端口 ⇒ 多输出端口时不确定。改为按 (i,op) 字典序。
# (c) 原阶段二「min later node on a path to last」在 v 的后继都不可达 sink 时是空集 ⇒ 表达式无定义。
#     改为「下标 > v 且有空闲兼容入端口的最小 j」，并显式处理 tgt == null（返回 null，不是死循环）。
#     升序遍历 + 只向后连边 ⇒ 一遍即可，无需 while 反复扫。

allowed_cap(st, idx):
  if len(st.nodes) >= MAX_NODES: return false
  c = contracts[idx]
  if len(st.nodes) == 0:                                 # 首节点
    if c has no input ports: ok = exists artifact in entry_supply
    else ok = every required p has exactly one entry_supply compat
               (or task spec explicit map); 0 or >1 without map ⇒ not allowed
               (compile will also reject entry_ambiguous if such a graph is forced)
  else:
    if c has no input ports: return false                # 无输入端口只能首位
    ok = every required p has exists (i,op), i < len(st.nodes),
           compat(out_type(st,i,op), p.type) and role_ok(...)
         # 注：非首节点「≥1 入边」由上一行蕴含（有 required 输入时）；
         #     若 c 全部输入均 required:false，仍须能连至少一条入边，故另判：
         and (has_required_input(c) or exists (i,op,ip) compatible)
  if not ok: return false
  # 关键：新节点成为 sink ⇒ 原 sink 的后继约束变化，必须整体重算闭合
  return simulate_closure(st + NODE idx) != null         # 禁止 max_depth+need

# 原缺陷：只判「required 有兼容前驱」，未判「全部输入 required:false 的契约在非首位仍需 ≥1 入边」。
# 这类契约（如只吃 optional 输入的 summarizer）会被放行成孤立节点，
# 随后 simulate_closure 才补边——但补的是「出边到 sink」，入边仍为 0 ⇒ 闭合定义被违反。
# 现在在 allowed_cap 就拦住。

mask(st):
  NODE idx        : allowed_cap(st, idx)
  LINK i:op->j:ip : i < j and j < len(st.nodes)           # 只连已生成节点
                    and compat(out_type(st,i,op), in_type(j,ip))
                    and role_ok(out_role(st,i,op), in_role(j,ip))
                    and not is_confidence_port(st,i,op)   # confidence 是旁路观测位，不进数据流
                    and (i,op,j,ip) not in st.edges       # 禁重复边（同端口对二次连接无语义、只浪费 token）
                    and in_degree(j,ip) < cardinality_max(j,ip)
                    and (binding_mode(j,ip) != 'any' or in_degree(j,ip) == 0
                         or ALLOW_MULTI_ANY_CAND)         # any 端口收候选：cardinality=1 但候选可多条，见下
                    and common_supertype_exists(existing_types(j,ip) ∪ out_type(i,op))
                    and len(st.edges) < MAX_EDGES
                    and depth_after(st, i, j) <= MAX_DEPTH
  LINK i->j       : unique_match(i,j) != null and LINK-with-ports mask holds for that pair
  EXIT_STOP       : simulate_closure(st) == st           # 已闭合；空图为 false

# 【口径修正：any 端口的 in_degree 与 cardinality 不是同一件事】
# 《契约与图》说 any 端口「必须 cardinality=1」且「必须至少有一条候选边」，还要「路由恰选一条」。
# ⇒ any 端口的 in_degree 必须允许 > 1（多条候选边），否则「路由选边」无从选、OR 分支不存在。
# 写死：cardinality 约束「运行时注入的 artifact 数」（any 恰 1 个），
#       in_degree 约束「拓扑上的候选边数」（any 允许 1..MAX_ANY_CAND）。
#       故 cardinality_max(j,ip) 对 any 端口取 MAX_ANY_CAND（住账本，默认 3），
#       对 all 端口取 1（cardinality:1）或 MAX_FANIN（cardinality:'n'，默认 3，与扇出 N≤3 同源）。
#       ALLOW_MULTI_ANY_CAND 恒为 true；该行保留是为了让约束显式，不是开关。

decode(policy, budget):
  st = empty
  loop:
    if budget.exhausted():                               # 先查预算，再采样
      st = complete_greedy(st, fail_reason="closure_budget"); stop_kind = "BUDGET_STOP"
      if st == null:
        return null, events                                 # incomplete 由 complete_greedy 唯一发射
      break
    m = mask(st)
    if m has no legal token:                              # 空图或非空图都可能撞墙
      if st is empty:
        events.push(decode_fallback, kind="no_legal_node"); assert false   # 池不变量被破坏 ⇒ GA1 红
      # 非空图：EXIT_STOP 若合法必在 m 中；不在 ⇒ 未闭合且无边可加
      st = complete_greedy(st, fail_reason="no_legal_token"); stop_kind = "NO_LEGAL_TOKEN"
      if st == null:
        return null, events                                 # incomplete 由 complete_greedy 唯一发射
      break
    t = sample(masked_softmax(policy.forward(st), m))
    if t == EXIT_STOP:
      stop_kind = "EXIT_STOP"; break
    if t is NODE idx:
      assert allowed_cap(st, idx)                        # mask 已保证；失败 = 解码器 bug（不是 fallback）
      st.nodes.push(idx)
      continue                                            # 关键：一次循环只消费一个 token
    if t is LINK i->j:                                   # 省略端口
      pair = unique_match(i,j); assert pair != null      # mask 后不应失败
      st.edges.push(pair); continue
    if t is LINK (i,op,j,ip):
      # mask 已排除不可行边 ⇒ 这里不该再出现 infeasible。保留 fallback 只为「mask 与 feasible 判据实现不一致」
      # 这一类实现 bug 的可观测出口：记 decode_fallback 并计入 GA1 诊断列（不是正常路径）。
      if not feasible(st, i,op,j,ip):
        pair = min_compatible_predecessor(st, j, ip)
        if pair == null:
          events.push(decode_fallback, kind="no_compatible_predecessor"); assert false
        (i,op,j,ip) = pair
        events.push(decode_fallback, kind="infeasible_sample")
      st.edges.push((i,op,j,ip)); continue
  if simulate_closure(st) != st:
    st = complete_greedy(st, fail_reason="closure_budget_or_sink")
    if st == null: return null, events                     # incomplete 由 complete_greedy 唯一发射
  events.push(decode_stop_kind = stop_kind)
  return st, events
```

**J.1 已修的四处**：
① **原循环无 `continue`/`elif`**：`t is NODE idx` 后继续落到 `t is LINK ...` 判断，靠"类型不匹配"隐式跳过 —— 伪码不该依赖这个。改为显式 `continue`。
② **`no_legal_node` 只在空图判**：非空图 mask 全空（未闭合且无合法边、`EXIT_STOP` 也被 mask）时原代码会 `sample` 一个空分布。补 `NO_LEGAL_TOKEN` 分支走贪心补齐。
③ **`allowed_cap` 二次校验被写成 `decode_fallback`**：mask 已保证合法，此处失败是**解码器 bug**，应 `assert` 而不是记回退（记回退会把 bug 伪装成正常路径）。
④ **`min_compatible_predecessor` 可能返回 null**（该端口确无兼容前驱），原代码未处理。

### J.2 贪心补齐

```
complete_greedy(st, fail_reason="closure_budget_or_sink"):   # decode 期 incomplete 的唯一发射点
  t = simulate_closure(st)                               # 与 allowed_cap 同一规则
  if t == null:
    events.push(incomplete, reason=fail_reason); return null
  for each extra edge in t.edges \ st.edges:
    if budget.exhausted():
      events.push(incomplete, reason=fail_reason); return null
    events.push(greedy_completion)                       # 逐次记账，计入本任务预算
  return t                                               # 含 entry 虚拟边语义与 sink 出边；|V|≥1
```

### J.3 编译期静态检查（语法层 assert + 语义层 `compile_reject`）

```
compile(graph):
  assert |V| >= 1 and acyclic(graph) and all_reach_sink(graph)
  assert all_edges_type_compatible(graph) and within_limits(graph)
  # 上列失败 = 解码器 bug ⇒ GA1 红，不是 compile_reject
  if first-node required inputs are entry-ambiguous:     # 0 或 >1 且无 task spec 显式映射
    return reject("compile_reject", reason="entry_ambiguous")
  for each shared key K:
    pubs = { v : K in publishes(v) }
    if not pairwise_topo_comparable(pubs):
      if exists_execution_path_hitting_both(pubs):
        return reject("compile_reject", reason="publish_order")
      if not has_join_contract(graph, K):                # 解码器不能 mask 此全局约束
        return reject("compile_reject", reason="missing_join")
  for each input port with cardinality 'n':
    if not common_supertype_exists(in_types(port)):
      return reject("compile_reject", reason="merge_type")
  return plan_skeleton(graph)                            # 不含活动子图：活动子图执行期定
```

### J.4 运行时执行（拉式惰性活动子图 / memo / 进展 / 发布）

```
# slot 键 = (node_index, out_port)
# 拉式惰性（《契约与图》§二「活动子图的执行语义」）：从 sink 反向 demand；
#   all 端口 ⇒ 求值全部入边前驱；any 端口 ⇒ 先由路由选边、再只求值被选前驱。
#   选边发生在候选产出之前 ⇒ 路由 obs 不含候选产物内容，只含候选边静态特征。
# step 是全局递增计数器（按实际执行顺序），不是节点下标。

run(graph, plan, task, shared0, budget):
  st = { task, shared: shared0, slots: {}, step: 0, evaluated: {}, in_progress: {} }
  sink = last_index(graph.nodes)
  demand(sink, st, graph, budget)
  for v in graph.nodes where v not in st.evaluated:
    events.push(branch_not_taken, node_index=v)          # 0 计费、只记聚合计数
  return st

demand(v, st, graph, budget):                            # 返回 v 的产物或 refusal
  if v in st.evaluated: return st.evaluated[v]
  assert v not in st.in_progress                         # DAG ⇒ 不可能重入；失败 = 编译期漏判环
  st.in_progress.add(v)

  # ① 解析入端口 ⇒ 递归求值前驱
  inputs = {}
  for p in declared_order(inputs_of(v)):
    if binding_mode(p) == 'all':
      for (u, op) in in_edges(graph, v, p) sorted by (u, op):
        r = demand(u, st, graph, budget)
        if is_refusal(r) or budget.stopped: st.in_progress.remove(v); return propagate(r)
        inputs[p].append(r.slots[(u, op)])
    else:                                                # any：先选边，再只求被选前驱
      cands = in_edges(graph, v, p)                      # 1..MAX_ANY_CAND 条候选
      # route_obs 含 VOI 特征（借自 VOI budget control，§0.1）：
      #   对每条候选边 e 给一个 value-of-information 特征 = 该边前驱的期望边际收益 / 其 cost 先验，
      #   即"下一个预算单位投给它值不值"。这是**特征**，不替代学习（路由仍由模型选边）。
      #   VOI 是确定性函数（只用 cost 先验、历史成功率、剩余预算），故不破坏可重放。
      obs = route_obs(st, graph, v, p, cands, voi=voi_of(cands, st.budget))   # 不含候选产物内容
      pick = router.select(obs)                          # 确定性：同 obs 同 seed 同选择
      events.push(edge_choice, node_index=v, port=p, chosen=pick)
      r = demand(pick.u, st, graph, budget)
      if is_refusal(r) or budget.stopped: st.in_progress.remove(v); return propagate(r)
      inputs[p] = r.slots[(pick.u, pick.op)]
  for p in optional_unbound(v): pass                     # required:false 且无入边 ⇒ 不注入

  # ② entry 虚拟边（首节点）
  if v == 0: inputs ∪= entry_bind(task.entry_supply, v)

  # ③ 冗余判定 / 实例选择 / memo
  if pre_exec_redundant(v, st):                          # 同键无 variant 递增，或本 (v, step) 已调度
    events.push(redundant_reject); st.in_progress.remove(v)
    return refusal("redundant")                          # 不计费
  inst = choose_instance(v, st)                          # J.5；A/B 由 harness 覆盖
  events.push(chosen_instance, node_index=v, instance_id=inst.node_id)
  if memo_eligible(inst):                                # trainable / 无端口 tool / 全 exact 的 composite
    key = memo_key(task, v, slot_versions(inputs), read_versions(v), bindings(inst), variant_index(v))
    if key in memo:
      replay_slots_and_publishes(v, memo[key])           # 版本不变、不额外计费
      events.push(memo_hit); st.evaluated[v] = memo[key]
      st.in_progress.remove(v); return memo[key]

  # ④ 执行
  assert_reads_declared(v); assert_single_writer(v)
  audit, arts = execute(v, inst, inputs, read_shared(v, st), budget)   # L1 见 J.15
  budget.charge(audit.eff_requests)                      # 实测，不用 cost_model
  if budget.stopped:                                     # cap 拒发 ⇒ 收口
    events.push(budget_event, kind="cap_block")
    st.in_progress.remove(v); return refusal("budget")
  assert_typed(arts)
  # wasted_step 的唯一落点在 L1 循环（J.15）与 composite 内部执行：
  # 外层 DAG 节点首次执行必有新信息，此处不重复判（否则同一次重试会被记两次）。
  for (port, art) in arts: st.slots[(v, port)] = art
  for K in publishes(v): publish_append(K, declared_output(arts, K))   # 追加新版本，不就地替换
  st.step += 1
  st.evaluated[v] = { slots: arts, refusal: null }
  st.in_progress.remove(v)
  return st.evaluated[v]
```

**J.4 已改的五处（对齐拉式惰性口径）**：
① **推式 `ready` 集合 → 拉式 `demand` 递归**：原版必须先跑完所有候选才能"在已产出候选里选"，OR 不省预算、`branch_not_taken` 形同虚设。
② **`branch_not_taken` 改为末尾统一登记**：未被 demand 到的节点即未命中分支，0 计费。
③ **`resolve_any_ports(..., produced_candidates_only=true)` 删除**：改为选边在前、求值在后，`route_obs` 明确不含候选产物。
④ **`publish_atomic` → `publish_append`**：`shared[K]` 是**版本序列**（`Artifact[]`），发布是追加新版本而非原子替换——旧版本必须仍可被轨迹与 `pins` 指到（《契约与图》§2.2 规则 5、规则 8「覆盖 = 版本化」）。"原子替换"与"旧版本仍可指到"自相矛盾。
⑤ **`wasted_step` 判定收敛到唯一落点**：只由 L1 循环（J.15）与 composite 内部执行产生；J.4 侧删除重复判定（原两处都记会把同一次重试记两次），与《契约与图》§2.2 的「唯一来源」口径一致。

### J.5 实例选择（确定性）

> **来源标注**：`shadow-before-live` 不变量借自 **ATM（arXiv 2607.20488）**，见 §0.5-C。
> 差别：ATM 在运行中的团队上 hot-swap（需保 `agent_id` / A2A 地址连续）；本项目在回合边界改池，
> 离线、可 `set_active` 回滚 ⇒ 更保守，**不需要** identity 保持。

```
choose_instance(v, st):
  if harness_forced_instance(v): return that            # 仅 A/B 评测；不经解码器
  # 【ATM 不变量③ shadow-before-live】未转正实例（shadow=true）**不得**进入真实执行流：
  #   只有在「该契约没有已转正实例」时才允许被选中（此时它是唯一可用者，且仍走影子评估）。
  #   断言：返回的实例若 shadow=true，则 instances(v) 中不存在 shadow=false 者。违反 = 门禁红。
  # 字典序：shadow 升序, success_lower_bound 降序, cost 升序, node_id 升序
  # shadow 或 n=0 ⇒ success_lower_bound = 0（仅排序键；影子转正比较用未置零的原始下界）
  pick = lex_first(instances(v),
           key = (shadow?1:0, -success_lower_bound, cost, node_id))
  assert not pick.shadow or all(inst.shadow for inst in instances(v))
  return pick
```

### J.6 结晶契约合成

> **来源标注**：结晶 = 结构化重构，借自 **PSN（arXiv 2601.03509）** 的 structural refactoring +
> maturity-aware gating；三条形式不变量借自 **ATM（arXiv 2607.20488）**，见 §0.5-C。
> **与 PSN 的差别**：PSN 合并冗余技能；本项目把子图折成**新的可寻址能力类**（同时增专家、增 `action_head` 列、`H` 下降）。

```
# and_backbone_and_sink = 所有 any 实例化下都会执行的节点 ∪ sink（仅 OR 分支上的 post 不进入）
# 新契约 canary_set 初始 pending，首次任务级通过后按 J.14 pin
synthesize_contract(sub):
  reads = union(reads(v) for v in sub)
  for K in reads:
    if K in union(publishes(v) for v in sub):
      if all read points of K occur after first_publish(sub, K):
        reads.remove(K)                                  # 内部闭环不进新契约
  c = Contract(
    inputs  = entry_map(sub),
    outputs = exit_outputs(sub),
    reads   = reads,                                     # 首次发布前被读的键保留
    publishes = union(publishes(v)),
    pre  = conjunction(pre(v) for v in entry_nodes(sub)),
    post = conjunction(post(v) for v in and_backbone_and_sink(sub)),  # 不含仅 OR 分支上的 post；不得任务级
    refuses = union(refuses(v)),
    effects = union(effects(v)),                         # 取并集不取子集
    cost = longest_path_aggregate(sub),
    idempotent = all(effective_determinism(v) == 'exact'),
    touches_effects = any_effects(sub),
    can_delegate = any_delegate(sub),
    determinism = min_effective_determinism(sub),
    delegate_reads = union(delegate_reads(v)) ∩ reads,
    canary_set = pending)
  # 【ATM 不变量① capability monotonicity：子 ⊆ 父】合成后必须断言新契约**不窄于**子图并集。
  # 允许变宽（并集自然变宽），**禁止**变窄——变窄意味着结晶后能力丢失，属合成 bug。
  assert c.effects ⊇ union(effects(v) for v in sub)
  assert c.refuses ⊇ union(refuses(v) for v in sub)
  assert c.publishes ⊇ union(publishes(v) for v in sub)
  # 【ATM 不变量② state-routing completeness：slot ↔ 端口双向完整】
  #   ① 子图内每个 slot 写入都能映射到某个 outputs 端口（否则该产物在结晶后不可达）
  #   ② 子图内每个读都有对应入边或 reads 条目（否则结晶后读不到）
  #   任一缺失 ⇒ compile_reject(reason='crystallize_incomplete')，不产出契约。
  assert slot_writes(sub) ⊆ ports_of(c.outputs)
  assert reads_of(sub) ⊆ ports_of(c.inputs) ∪ c.reads
  return c

longest_path_aggregate(sub):
  # DAG 上按拓扑序 DP，四维分别聚合：dist[v] = cost_model(v) + max(dist[pred])
  # 返回 max over v of dist[v]（实例缺省回退契约 cost）
```

**maturity-aware gating（借自 PSN）与惰性训练的合流**：结晶节点的"成熟度"与惰性训练的
"未激活专家不更新"是同一件事的两面——**成熟 ⇒ 冻结**（不进梯度、`wd` 也 mask）、**未成熟 ⇒ 保持可塑**。
成熟判据（住账本）：该结晶节点在金丝雀集上的成功率下界连续若干回合不劣于其子图展开式，
或达到调用次数下限。**不设**"永久冻结"——成熟只影响更新频率，仍可被 `set_active` 回滚。

### J.7 MCTS（PUCT）

> **来源标注**：搜索算子借自 AFlow（ICLR'25，MCTS over code-workflow，执行反馈回传 + 成本-效果 Pareto）
> 与 GPTSwarm（ICML'24，可优化图）；**质量门三机制借自 ExTS（arXiv 2608.23848，在 AFlow 上验证）**，见 §0.5-B。

```
# motif 检索：boundary_inputs(motif) 与当前 unconnected required 类型兼容；索引键 = sub_sig
# prefix_sig(s) 只作 transposition table 键，不作 motif 匹配
# value head 输入 = 编排白名单部分拓扑特征 + 剩余预算三维；不另开特征源
# evaluate 的 cost 惩罚用 cost_exec（不含 walltime）

# —— 借自 ExTS 的三机制（§0.5-B）——
# ① discriminative reward shaping：分数分布窄（σ 小）时用**相对排名**而非绝对值做 Q，
#    否则 Q 差异全被噪声吃掉、选择退化为随机。
shaped_q(q_raw, siblings, sigma_floor):
  if stdev(siblings) >= sigma_floor: return q_raw
  return rank_percentile(q_raw, siblings)                 # 窄分布 ⇒ 用排名分离候选

# ② stochastic virtual child：从父节点奖励历史估计"新开分支"的价值，
#    让"扩展"与"加深"竞争同一份预算（原 PUCT 下扩展无条件发生）。
virtual_child_value(s):
  return bootstrap_sample(reward_history(s), n=VIRTUAL_CHILD_N)   # 确定性 RNG，seed 住 manifest

# ③ quality-conditioned branching（质量门）：父节点分数不足以支付扩展成本时**不扩展**，
#    预算转给"加深"已有高分链。这是 ExTS 在预算受限场景下的主要收益来源。
expansion_worthwhile(s, cost_estimate):
  return max(Q(s), virtual_child_value(s)) >= τ_gate * cost_estimate

expand(s):
  cand = masked({ motifs with compatible boundary(s) } ∪ { idx | allowed_cap(s, idx) })
  a1 = sample(cand)                                      # 第一层：motif 或契约
  if a1 is motif:
    s2 = splice(s, a1)                                   # 重标号接到 |s.nodes| 之后；失败则 skip
    if s2 == null: return null
  else:
    s2 = s + NODE a1
  ports = masked legal LINKs(s2) including unique-match form
  if ports empty and simulate_closure(s2) == null: return null
  if ports nonempty:
    a2 = sample(ports)                                   # 第二层：端口 / 省略端口唯一匹配
    s2 = s2 + LINK a2
  return s2

mcts_search(root, budget):
  fail_streak = 0
  while not budget.exhausted():
    s, path = select(root)                               # argmax Q + c·P·sqrt(N)/(1+N_a)；P=编排先验（评估臂可关）
    if terminal(s): v = evaluate(s)                      # 真验收 + cost_exec 惩罚 + value head
    else:
      # 质量门：不划算就不扩展，把预算让给加深（ExTS ③）。
      # τ_gate=0 时退化为原行为（无条件扩展）⇒ 该旋钮可作消融臂。
      if not expansion_worthwhile(s, cost_estimate(s)):
        path = path + [s]
        v = rollout(s)                                   # 不扩展，直接加深：rollout 当前状态
      else:
        s2 = expand(s)
        if s2 == null:
          mark_exhausted(s); fail_streak += 1            # 该状态无合法扩展 ⇒ 标记，避免下轮再选中
          if fail_streak > EXPAND_FAIL_MAX: break        # 全树无可扩展 ⇒ 收工（否则 while 空转到预算耗尽）
          continue
        fail_streak = 0
        path = path + [s2]
        v = rollout(s2)                                  # complete_greedy → 真验收（与生成臂同一补齐）
    backup(path, v)                                      # 沿整条路径回传访问均值；TT 键 = prefix_sig(s)
  # 返回两样：根动作 visit（给 THINK 的 PV 监督）与终局图 visit（给 listwise 目标）
  return { root_visits: visit_distribution(root),
           graph_visits: { sig(g): N(g) for g in terminal_states_seen } }
```

**J.7 已修的三处**：
① **`expand` 返回 null 时 `continue`** 而不标记该状态 ⇒ `select` 会反复选中同一个无法扩展的状态、循环空转到预算耗尽。补 `mark_exhausted` + `EXPAND_FAIL_MAX` 兜底。
② **`backup(s, v)` 只传叶子**：MCTS 的 backup 必须沿**选择路径**回传，否则父节点 `Q`/`N` 永不更新、PUCT 退化为随机。改为 `backup(path, v)`。
③ **返回值只有根 visit 分布**，而蒸馏的 listwise 目标需要**终局图的访问数** `N(g)`。补 `graph_visits`（对齐《控制与运行时》的 visit↔listwise 桥接口径）。

**质量门的门禁与回退（写死）**：`τ_gate` 与 `VIRTUAL_CHILD_N` 住账本、随 `MCTS_ROLLOUT` 配套登记（§G.21）。
**质量门会降低覆盖** ⇒ 报告必须把 `τ_gate` 与 `sig` 同构重复率、`any_port_density` **一起出列**；
若同构重复率超诊断线或 `any_port_density` 跌破诊断线 ⇒ **回退到 `τ_gate=0`**（即原无条件扩展行为），
并把该回退记入报告。**不许**在覆盖恶化的情况下继续保留质量门换成本好看。

### J.8 EA

> **来源标注**：交叉算子借自 EvoOR-Agent（AOE 网络 + 图介导 path-conditioned 重组）；
> **精英档案（QD）借自 MAP-Elites 路线**（YGN-SAGE 的 4D archive / ARES 的 NSGA-II，§0.5-A）。
> 与它们的分工差别：`pareto_select` 管"当前代不被支配"，`elite_archive` 管"历史各行为桶不坍塌"。

```
# 帕累托维：pass@1 最大、cost_exec 最小、H 最小。非支配层填满 EA_POP；层内 crowding 降序、并列 sig 升序。
# 交叉只重组边（family_sig 已保证节点契约多重集相同）。失败返回 null，记 invalid_crossover，不克隆父代。

canon_nodes(g):
  return argsort g.nodes by (contract_idx, orig_index)   # 稳定双射；两父代 family_sig 相同 ⇒ 对齐后契约序列全等
  # 注意：对齐序 ≠ 生成序。边在对齐下标下可能出现 i > j（对齐把同契约节点聚到一起）。
  # 因此 crossover 必须 reindex_to_topo_order 回生成序，否则「i<j 保持无环」这条不成立。

reindex_to_topo_order(g):
  # 对齐下标下的边集做拓扑排序 ⇒ 得到新生成序；有环则返回 null。
  # 排序在同层内按 (contract_idx, 对齐下标) 升序，保证确定性。
  order = topo_sort(g, tiebreak=(contract_idx, aligned_index))
  if order == null: return null
  return relabel(g, order)

pareto_select(pool, k=EA_POP):
  fronts = nondominated_sort(pool, max=pass@1, min=cost_exec, min=H)
  out = []
  for F in fronts:
    if |out| + |F| <= k: out += F
    else:
      out += sort(F, key=(-crowding(F), sig))[: k-|out|]
      break
  return out

# —— 借自 MAP-Elites（YGN-SAGE / ARES 的 QD 路线，§0.5-A）——
# 与 pareto_select 的分工：pareto_select 选「当前代 Pareto 前沿」（防被支配）；
# elite_archive 选「历史各行为桶最优」（防坍塌）。两者互补、不可互替。
#
# 行为维度（住账本）：|V| 档 × 最大深度档 × cost_exec 档 × 契约多样性档（不同 contract_id 数）。
# 分桶函数必须确定性（同图必落同桶），否则档案本身不可重放。
behavior_bucket(g):
  return ( bin(|V|,        VBINS),
           bin(max_depth(g), DBINS),
           bin(cost_exec(g), CBINS),
           bin(|distinct contract_id|, KBINS) )

# 档案是**跨回合持久**的演化级结构（进 manifest，随 run 冻结）；
# 每桶只留一个精英：先按 pass@1，再按 -cost_exec，最后按 sig 字典序（保证确定性、无并列歧义）。
elite_archive = {}                                        # bucket -> elite

archive_update(archive, g, score):
  b = behavior_bucket(g)
  cur = archive.get(b)
  if cur == null or better(score(g), score(cur)): archive[b] = g
  return archive

# 用途①：EA 的初始种群从档案采样，而非只从当前池 ⇒ 防「池收敛到单一行为区」的坍塌。
# 采样按桶均匀（不是按个体均匀），否则大桶会淹没小桶、QD 失效。
archive_seed(archive, k, rng):
  buckets = sorted(archive.keys())                        # 排序保证确定性
  return [archive[b] for b in rng.sample_uniform(buckets, min(k, |buckets|))]

mutate(p, rng):
  op = rng.choice([insert, delete, replace_same_contract, redirect_edge,
                   add_skip, add_branch, add_join, early_exit])
  c = apply(op, p, rng)                                  # insert/delete 可改 family_sig；redirect 等不改
  c = simulate_closure(c)
  if c == null or not valid(c): return null
  return c

crossover(p1, p2, rng):
  if family_sig(p1) != family_sig(p2): return null
  a, b = canon_nodes(p1), canon_nodes(p2)                # 对齐后 nodes 的契约序列相同
  N = |a.nodes|; if N < 2: return null
  cut = 1 + rng.int(N-1)                                 # 搜索 RNG，禁止 hash 冒充随机
  child.nodes = a.nodes                                  # = b.nodes（family_sig 相同 ⇒ 对齐后全等）
  child.edges = []
  # 按目标节点分段取边：j < cut 的入边取自 a，j >= cut 的入边取自 b。
  # 逐边增量校验（in_degree / cardinality 上限依赖已加入的边，故必须按 (j, ip, i, op) 升序插入）
  for e in sorted(edges_of(a) ∪ edges_of(b), by=(j, ip, i, op)):
    src = a if e.j < cut else b
    if not src.has(e): continue
    if e in child.edges: continue                        # a、b 可能有相同边
    if not type_compat(child, e): continue
    if in_degree(child, e.j, e.ip) >= cardinality_max(e.j, e.ip): continue
    if len(child.edges) >= MAX_EDGES: break
    if not common_supertype_exists(child, e): continue
    child.edges.push(e)
  # 关键：child 的 nodes 来自 a 的生成序，但 canon_nodes 的排序键是 (contract_idx, orig_index)，
  # 与生成序不同 ⇒ 必须重建生成序并检查 i<j 仍成立；不成立的边丢弃（否则引入环）。
  child = reindex_to_topo_order(child)
  if child == null: return null                          # 对齐下无法拓扑排序（有环）⇒ 交叉失败
  child = simulate_closure(child)
  if child == null or not valid(child): return null      # 含 compile_reject
  if sig(child) in {sig(p1), sig(p2)}: return null       # 退化为父代 = 交叉无效
  return child

crossover_pairs(pool, rng):
  groups = group_by family_sig; within group sort by sig
  pairs = adjacent_pairs(groups)                         # (0,1),(2,3),… 不足丢弃
  return [pair for pair in pairs if rng.bernoulli(EA_CX)]

ea_step(pool, rng, archive):
  children = []
  # 初始种群：档案精英 + 当前代 Pareto 前沿（前者防坍塌、后者防被支配）
  seed = archive_seed(archive, ARCHIVE_SEED_K, rng) + pareto_select(pool)
  for p in seed:
    c = mutate(p, rng)
    if c != null and sig(c) not in pool: children.push(c)
  for (p1, p2) in crossover_pairs(pool, rng):
    c = crossover(p1, p2, rng)
    if c == null: events.push(invalid_crossover); continue
    if sig(c) not in pool: children.push(c)
  return children
```

### J.9 漂移检测（CUSUM，阈值按目标 ARL 预注册）

```
# 默认 CUSUM；h/slack 按目标 ARL 预注册，禁事后改。SPRT 不得并行（冲突隔离）。
# x_success ∈ {0,1} 每次调用；x_ece 仅 confidence 契约、按窗口 ECE。
# target = 该实例转正时在金丝雀集上的成功率基线（pin 进池版本，不用滚动均值——否则 target 跟着漂）
# 触发 ⇒ quarantine（defs 链）+ evidence_id kind=drift；金丝雀 pending 不进本检测。
# 模型 id / provider 时间戳变化 ⇒ 重测金丝雀并 reset(state_dn, state_up)，记 note。

cusum_update(st, x, target, slack, h):
  st.dn = max(0, st.dn + (target - x) - slack)           # 下降侧：x 持续低于 target 时累积
  st.up = max(0, st.up + (x - target) - slack)           # 上升侧：x 持续高于 target 时累积
  return { fired: st.dn > h or st.up > h,
           side: "down" if st.dn > h else ("up" if st.up > h else null) }
```

**J.9 已修的两处**：
① **原式 `state + (x - target) - slack` 是上升侧**（`x > target` 才累积），但注释写"下降侧" —— 符号与注释矛盾，直接实现会导致**能力退化永不触发**。改为显式两条状态。
② **上升侧不是可选项**：`side="up"` 同样是漂移证据（provider 静默换成更强模型也会破坏基线可比与配对统计），也须记 `evidence`；但动作不同——下降侧 ⇒ 隔离/降级，上升侧 ⇒ **强制重测金丝雀 + 重置基线**（不隔离），两者都必留痕。

### J.10 接受闸统计（配对非劣；配对单位 = 独立簇）

```
# 配对单位 = 独立簇 (template_id, k_files, defect_site)，不是任务（§I.2）。
# 簇内的 rename_seed 副本先聚合成簇级 pass 比例 ∈ {0, 0.5, 1}。
# 窗口 = 当前 incumbent 生效以来的累计簇（跨采纳清零，见《进化与账本》§一）。

cluster_pairs(round_results_window):
  out = []
  for c in clusters(round_results_window):
    new_rate = mean(pass@1(new, t)  for t in tasks(c))    # {0, 0.5, 1}
    inc_rate = mean(pass@1(inc, t)  for t in tasks(c))
    out.push((new_rate, inc_rate))                        # 同簇必在同一回合共评
  return out

paired_noninferiority(pairs, delta, n_min, window_round_idx, seq_boundary):
  # pairs = [(new_rate_c, inc_rate_c)]；差值 d_c = new_rate_c - inc_rate_c ∈ {-1,-0.5,0,0.5,1}
  # alpha = seq_boundary(window_round_idx) 由该窗口预注册的 group-sequential 给出，禁事后改
  n = len(pairs)
  if n < n_min: return "未判定"                           # 不采纳、不算失败
  # 簇级比例不是二元 ⇒ 不能用 McNemar/Newcombe 的二元配对口径。
  # 写死：BCa 自助（bootstrap over clusters，B=10000，seed 住 manifest）算 mean(d) 的单侧下限。
  ci_low, ci_high = bootstrap_bca_ci(pairs, alpha=seq_boundary(window_round_idx), B=10000)
  h = (ci_high - ci_low) / 2
  if h > delta: return "未判定"
  return "非劣" if ci_low >= -delta else "拒绝"
```

**J.10 已修的两处**：
① **原用 `newcombe_ci` + "McNemar 口径"**：那是**二元配对**（0/1）的方法；配对单位改为簇后，簇级成绩是**比例**（0/0.5/1），二元方法不适用。改为**按簇自助（BCa）**——它对任意有界配对差值都成立，且天然处理簇内相关。
② **`n_min` 的语义**：`n` 是**簇数**（≥ 200），不是任务数（原文两处混用会让 `n=200` 被 640 个任务轻易"满足"，CI 系统性过窄）。
> `wilson_ci` 保留用于**单臂 pass@1 的展示性 CI**（任务级二元），不再用于采纳闸；§J 开头的判定清单已同步。
> （J.10 内文提到的 McNemar/Newcombe 仅作"二元配对口径不适用"的反例说明，不是现用方法。）

### J.11 数据飞轮入库（四道闸骨架）

```
admit(sample, train_set):
  if sample.producer == oracle: return reject            # GA2 隔离；f_* 只读不入集
  if not adversarial_suite_pass(sample): return reject
  if leak_scan(sample): return reject                    # GA5
  if dedup_hit(sample, train_set): return reject         # L1=字节哈希，L2=graph_sig 规范化
  if not replayable(sample): return reject               # 回灌下逐字节等价
  train_set.add(sample); return accept
```

### J.12 L2 子图委派与预算切分

```
# inherited shared = 父契约 delegate_reads（⊆ reads）切片；未声明键不可见
# parent.l2_policy.budget_split 来自 bindings.retry_policy 同源的 policy def（put(slot='binding.retry_policy') 可切版本）
# 默认 split = remaining × θ_l2（住账本）；子图 incomplete ⇒ 父节点合法拒绝 max_recur / subgraph_incomplete，已切预算不归还

delegate(parent, subgoal, budget):
  child_depth = parent.depth + 1
  if child_depth > MAX_RECUR: return refuse("max_recur")
  slice = split(budget.remaining, parent.l2_policy.budget_split)
  if slice is zero_in_any_dim: return refuse("budget")   # 预算已无可切 ⇒ 直接拒，不进解码
  budget.remaining -= slice                              # 转移：父图剩余同步减少
  child_budget = Budget(slice)
  # GA8⑩ 自治档位臂旁路：harness 可 pin 一张 sub，跳过解码 ⇒ 三档跑同一张图、无拓扑方差
  if harness_pinned_sub(parent): sub = harness_pinned_sub(parent)
  else:
    # 子图解码的 decode token 必须记在 child_budget（它已从父预算切出），
    # 否则会被重复计一次（父先扣 slice、解码又扣父预算）。
    sub = decode_with_think(policy, child_budget, ctx_route_of(task))
  if sub == null: return refuse("subgraph_incomplete")   # 已切预算不归还
  plan = compile(sub)
  if plan is compile_reject: return refuse("subgraph_reject", detail=plan.reason)  # 已切预算不归还
  shared_in = slice_shared(parent.shared, parent.contract.delegate_reads)
  result = run(sub, plan, task, shared_in, child_budget, depth=child_depth)
  events.push(delegate_audit, parent=parent.node_index, depth=child_depth,
              slice=slice, spent=child_budget.spent, result=verdict_of(result))
  # 子图的 sink 产出映射到父节点声明的 outputs；映射由父契约 outputs 与子图 sink outputs 的
  # 类型+role 唯一匹配确定，0 或 >1 ⇒ refuse("delegate_output_ambiguous")
  return map_sink_outputs_to_parent_outputs(result, parent.contract.outputs)
```

**J.12 已修的四处**：
① **子图解码成本双计**：原版 `decode(policy, slice)` 只把 `slice` 当上限传入，但 `slice` 已从父预算扣除 ⇒ 解码若仍记父预算就是重复计费。改为传 `child_budget`。
② **`slice` 可能为零**：`remaining × θ_l2` 在预算将尽时四维中某维可能取到 0，此时解码必然 `incomplete`、白记一次。改为提前 `refuse("budget")`。
③ **`result.exit_outputs` 未定义**：子图有自己的 `sink`，父节点有自己声明的 `outputs`，两者形状不同 ⇒ 必须有显式映射规则（补 `map_sink_outputs_to_parent_outputs` + 歧义拒绝码）。
④ **`audit(...)` 改为一等事件 `delegate_audit`** 并补 `spent` 字段（"父图消耗 / 子图消耗分开记"需要它）。

### J.13 控制层 THINK 前缀（解码期；损失见 §J.16）

```
# 编排 / 分解 / 路由在产出最终 token 前先过 THINK 段。词表 = {THINK, THINK_STOP}。
# THINK 不进 sig、不跑 gate、不占 NODE 位置编号。
# 计费 = 实际采样的控制层 decode token，进本任务 B。MAX_THINK 是上限不是保底。
# 路由另受 MAX_THINK_TASK（每任务累计）约束。

think_prefix(policy, budget, max_think, ctx, max_think_task=None):
  # ctx.think_used 是**按任务累计**的可变计数器（每模型一份），不是常量 0
  # max_think_task 只由**路由**传入 MAX_THINK_TASK；编排/分解传 None（只受 MAX_THINK 与任务 B 约束）
  tokens = []
  for i in 1..max_think:
    if budget.exhausted() or (max_think_task != null and ctx.think_used >= max_think_task):
      break                                              # 触上限即停，确定性
    t = sample(masked_softmax(policy.think_forward(tokens), {THINK, THINK_STOP}))
    if t == THINK_STOP: break
    tokens.push(t); budget.charge_decode(1); ctx.think_used += 1
  events.push(think_stop, n=len(tokens), think_used=ctx.think_used)
  return tokens                                          # 隐状态 h 留给 readout 头；token 本身不写入图

decode_with_think(policy, budget, ctx):
  h = think_prefix(policy, budget, MAX_THINK, ctx)        # h 进 think_losses（J.16）
  return decode(policy, budget)                          # J.1
```

**J.13 已修的三处**：
① **`task_think_used` 原以常量 `0` 传入** ⇒ `MAX_THINK_TASK` 恒不触发、每任务思考量无界。改为可变 `ctx.think_used`。
② **`MAX_THINK_TASK` 的归属**：设计文档写"**路由**每任务思考总量 ≤ `MAX_THINK_TASK`"，因为路由每个 `any` 端口都思考一次、次数与图规模成正比；编排/分解每任务各只生成一次，`MAX_THINK` 已封住。故 **`ctx` 按模型分开计**：路由的 `ctx.think_used` 跨该任务全部 `any` 端口累计并受 `MAX_THINK_TASK` 约束；编排与分解各自每次生成受 `MAX_THINK` 约束、**不受** `MAX_THINK_TASK` 约束（但仍受任务 `B` 约束）。
③ **`THINK ∪ {THINK_STOP}`** 写法把 `THINK`（单个 token）当集合，改为 `{THINK, THINK_STOP}`；**`MAX_THINK_TASK` 的归属由 `max_think_task` 参数落实**（路由传 `MAX_THINK_TASK`，编排/分解传 `null`）。

### J.14 金丝雀反向切片

```
# 参考图 = 该契约节点在首次任务级验收通过的图中、沿入边回溯到 entry_supply 的诱导子图
# 多图取 sig 最小。pin 前 health=pending，不进 CUSUM。只跑金丝雀，不进蒸馏 / 真实执行流。
# 金丝雀任务必须 entry_supply 与切片边界类型兼容，否则不得入该契约的 20 任务集。

reverse_slice(graph, node_v):
  keep = ancestors(graph, node_v) ∪ {node_v}             # 沿入边回溯
  sub = induce(graph, keep)
  return { nodes: relabel_by_gen_order(sub),
           edges: sorted relabeled,
           boundary_inputs: unsatisfied_required(sub),
           boundary_outputs: outputs(node_v) }

pin_canary(contract_id, passing_graphs, dev_pool):
  g = min_sig { g in passing_graphs | g contains contract_id }
  slice = reverse_slice(g, first_node_of(contract_id, g))
  tasks = stratified_sample(dev_pool, n=20, D_bins, min_per_bin=2,
                            filter = entry_compat(slice.boundary_inputs))
  if |tasks| < 20: pending remains; do not start CUSUM
  ledger.put(canary_set = { slice, tasks }); health starts rolling per instance
```

### J.15 L1 有界循环

```
# K、退出条件来自 bindings.retry_policy（put(slot='binding.retry_policy') 可切 active 版本）
# 每次尝试独立 EffRequest + variant_index 递增；禁止裸重试同键
# request_input：key 必须 ∈ reads；记 input_request（算新信息）

execute_l1(v, inst, inputs, budget):
  K = inst.bindings.retry_policy.K
  audit = empty; arts = null
  for k in 1..K:
    if budget.exhausted(): return audit, arts, "incomplete"   # arts 可能为 null（首轮就触顶）
    variant_index(v) = k                                  # 每次尝试递增，禁裸重试
    audit_k, arts_k = invoke(v, inst, inputs, budget)
    audit += audit_k
    # 空转判定：第 k 次与第 k-1 次逐字节相同且无新信息（《契约与图》§2.2 wasted_step 唯一来源）
    if k > 1 and not produces_new_info(arts_k, arts): events.push(wasted_step)
    arts = arts_k
    if post_pass(arts) or is_refusal(arts): return audit, arts, "done"
    if arts has request_input(key, need):
      events.push(input_request, key)
      if key not in optional_reads(v): return audit, refusal("undeclared_read"), "done"
      if not supply(key, budget): return audit, refusal("budget"), "done"
      inputs = inputs ∪ supplied
      continue                                            # 注意：不消耗 k 之外的额度，K 仍是总尝试上限
  return audit, arts, "max_retry"                          # 达上限，带最后产物
```

**J.15 已修的四处**：
① **`arts` 在首轮触顶时未定义**（原 `return audit, last_arts` 里 `last_arts` 从未赋值）。显式初始化为 `null` 并让调用方处理。
② **返回元数一致**：原代码三个 `return` 分别返回 2 项与 3 项，调用方无法解构。统一为 3 项 `(audit, arts, status)`。
③ **`key not in reads(v)` → `optional_reads(v)`**：只有标了 `optional:true` 的 `reads` 键可被请求（《控制与运行时》§二），非 optional 的 `reads` 键运行时已注入、请求它是逻辑错误。
④ **补 L1 空转判定**：`wasted_step` 在 DAG 下的唯一现实来源就是这里，原伪码没落点。

### J.16 THINK 监督（与 §J.13 配套）

```
# THINK 词表 = {THINK, THINK_STOP}；PV 动作 / value / 停机都是 readout，不改词表
# 编排 PV = MCTS 主变分路径上的第一层 expand 动作（motif|contract）
# 路由 PV = 该 any 端口的 search/teacher edge_choice
# 分解：teacher 计划序列作 think 目标（teacher_plan_ce），无 PV 则 L_pv=0
# stop-grad：L_think 不更新图解码头；L_listwise 可回传到 think 模块；L_gate 只 NODE 位

think_losses(h[1..T], pv, V_search, pass, teacher_plan):
  L_pv = L_v = L_stop = 0
  n_pv = 0
  for i in 1..min(T, |pv|):                              # 只在有 PV 目标的步上算，无需 min(i,|pv|) 夹取
    L_pv += CE(action_head(h[i]), pv[i-1]); n_pv += 1
  for i in 1..T:
    y = V_search[min(i, |V_search|)-1] if |V_search|>0 else pass   # 标量 [0,1]
    L_v += BCE(value_head(h[i]), y)
  # 长度归一：否则 T 大的样本天然贡献更大梯度，模型会学「多思考」来刷 loss 尺度
  L_pv = L_pv / max(n_pv, 1)
  L_v  = L_v  / T
  # 停机目标：教师认为该在第 |pv| 步停；无 PV 时不监督停机（不能拿 T 当目标——T 是模型自己的选择，
  # 用它当标签等于自我确认，会把任意长度都强化成「正确长度」）
  if |pv| > 0:
    stop_target = min(|pv|, MAX_THINK)
    for i in 1..T:
      L_stop += CE(stop_head(h[i]), THINK_STOP if i==stop_target else THINK)
    L_stop = L_stop / T
  else:
    L_stop = 0
  if teacher_plan: L_plan = CE_seq(readout_plan(h), teacher_plan) / |teacher_plan|   # 分解模型，单列
  else:            L_plan = 0
  return λ_th·L_pv + λ_v·L_v + λ_stop·L_stop + λ_th·L_plan   # 默认 0.10 / 0.05 / 0.02

train_step(batch):
  # batch = 16 个任务的蒸馏样本。每个 sample 携带该任务的**候选图集合**（listwise 需要集合，不是单图）
  #   sample.cands = [g_1..g_m]（该任务全部验收通过图）；sample.target_dist[g] ∝ N(g)（MCTS 访问数，未访问取 1）
  #   visit 不可得 ⇒ 帕累托退化档（前沿等权、被支配降权）；m==1 ⇒ 普通 CE
  L = 0
  for sample in batch:
    scores = []
    for g in sample.cands:
      h, logp = forward_with_think(sample.prefix, g)     # J.13 + J.1；teacher forcing 到 g 的 token 序列
      scores.push(logp / len(tokens(g)))                 # s(g)，长度归一（§G.1）
    L += listwise_ce(softmax(scores / τ), sample.target_dist, τ=1.0)
    # THINK / gate 损失只在**目标分布峰值图**（argmax target_dist）的前向上算一次，避免 m 倍重复
    h_star = forward_with_think(sample.prefix, argmax_g(sample.target_dist)).h
    L += think_losses(h_star, sample.pv, sample.V, sample.pass, sample.teacher_plan)   # stop-grad 到图解码头
    L += α · gate_ce(NODE_positions_only(h_star), sample.pv_contracts, mask=legal_only)
  # wd 由 AdamW 内部施加（decoupled），**不加到 L 里**；未激活专家的 wd 必须 mask（惰性训练）
  clip(grad, 1.0); adamw_step(lr=3e-4, wd=0.01, wd_mask=active_experts_only)
```

**J.16 已修的六处**：
① **`listwise` 缺候选集合**：原 `listwise(graph_tokens, sample.target_dist)` 只前向了一张图，而 listwise softmax 需要**同任务全部候选**的分数。补 `sample.cands` 与逐图前向。
② **visit 分布与 listwise 的桥接**落地为 `target_dist[g] ∝ N(g)`（与《控制与运行时》新增口径一致）。
③ **`L_pv` / `L_v` / `L_stop` 未做长度归一**：`T` 大的样本梯度天然更大 ⇒ 模型会学"多思考"来放大 loss 尺度。补按步数归一。
④ **`stop_target` 在无 PV 时取 `T`**（= 模型自己的输出长度）是**自我确认**标签：任何长度都会被强化成"正确长度"。改为无 PV 时不监督停机。
⑤ **`CE_seq(h, teacher_plan)` 混入 `L_pv`**：分解的计划序列与编排的 PV 动作是两个不同 head，不能加进同一项。拆出 `L_plan` 并走 `readout_plan` 头。
⑥ **`L += wd·||θ||²`**：AdamW 是 **decoupled weight decay**，衰减在优化器里施加，不进损失（写进损失就变成 L2 正则 = 退回 Adam+L2，与 §G.18 声明的 AdamW 不符）。同时补 `wd_mask`（惰性训练要求未激活专家不被衰减）。
