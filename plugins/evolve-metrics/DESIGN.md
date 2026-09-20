# #44 `evolve-metrics`（指标层 · 证据聚合）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 44 / `evolve-metrics` |
| 语言 | **Rust**（聚类 / 漂移 / 统计的纯计算，`ndarray` / `linfa` 一类）。与 #20/#25 同路：源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧 ③ 依赖缓存；**用户零运行时依赖**（纯二进制，无需额外解释器）（2026-09-20 确认：Rust 定案） |
| 职责 | **指标层**：读轨迹投影 → 失败模式聚类（`failure_cluster`）/ `post_failure` / 成本异常 / 实例漂移 / 折叠候选 / `no_progress` / `verify_failure` 七类 → 产**证据**条目写计划。**非 LLM、纯计算、同输入同输出** |
| 依赖 | pins `host`（**保留身份**：`audit` 读历史 `EffectAudit` 作 `shadow` 的**补充对照源**（D7；**v1 主配对源 = #43 `trace.eff_log`**，2026-09-20 修订））；`+` 43（投影读 `trace`）、**33（`thresholds`：periodic 路径经 `reads` 注入、#33 路径由其 bag 传；服务不读投影）**（2026-09-20 修订）；`<-` 33（pins：回合尾调 `aggregate`）、27（pins：`record` 经 #27 **能力类工具绑定**暴露——工具名 `record` 直绑本插件能力类方法，**无需 `describe`/`invoke`**，D2，2026-09-19 补登记） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["evolve-metrics"]`，`methods: {"evolve-metrics":["aggregate","sweep","shadow","record"]}` |
| 命令 | 无 |
| schema | `schema/evolve-metrics.json`（**两拍 periodic：`sweep` + `aggregate`**（`periodic:[{method:"sweep",…},{method:"aggregate", every_ms, reads:{"trace":["ids","evolution","body"], "thresholds":["ids","loop-policy","body","thresholds"]}}]`）——`aggregate` 亦周期：**图坏时（#33 回合尾不发）本插件仍能周期发 `orchestration.unhealthy`**；聚类阈值 / 窗口长度 / 成本异常倍数 / 漂移判据 / 折叠 k / `min_workspaces` / 轨迹保留回合数等**数值调参全部读 #33 `thresholds`**，本 schema 不重定义，D14）（2026-09-20 修订） |
| 机制 | 见下 |
| 边界 | **不做提案**（分签红线，见下）/ 不调模型 / 不直接写链（只返回计划）/ 不判"该不该改"（那是提案层与人闸）/ 不读世界本体（只投影） |
| 验收 | 1) **输出里不含任何提案**（机械可查：只产 `kind:'evidence'` 条目）；2) 同输入同输出（纯计算、不取时间不用随机，`now` 由 bag 传）；3) 聚类键含 `workspace_id`，跨工作区证据**不合并**；4) 单工作区证据只能支撑 `scope:workspace` 提案，跨 ≥`min_workspaces` 才可支撑 global；5) 回合尾调用**零 token**；6) 空轨迹返回空集不报错；7) 清理计划不动被 `verdict` 引用的轨迹 |
| 状态 | 新增（2026-09-19，agent 图与自进化）：完整设计见 `docs/plans/agent-graph-design.md` |

> **分签红线（结构性，不是纪律）**：本插件**只产证据、不产提案**；#45 `orchestration-admin` **只产提案、不产证据**。
> 两层用 `evidence_id` 接口连接。给本插件加任何提案面就等于"**自己诊断自己改**"——
> 评审再也无法机械验证证据是否被裁剪来迎合某个提案。这是从实验借用的五条之一（两层分签）。

> **为什么是执行件不是 term**：跨会话大规模统计受 `Fold`（集合长度）与 `gas` 限制，term 表达不了；
> 而纯计算执行件满足 `draft-design.md` §1.2 第 4 条「服务不写链、不做判定、同输入同输出」的可回放纪律。
> 本插件**不是判定者**——它只做机械统计，"该不该改"归 #45 与人闸。

---

## `aggregate`（宿主周期 + 回合尾调用，零 token）

```
aggregate(bag) -> { evidence: [...], $directives: [ write(batch: 证据条目 + 索引) ] }
```

读 `bag`：**periodic 路径**由宿主按 `schema.periodic.reads` 注入 `#43` `trace` 窗口（按 `prev` 链，窗口长度读 #33 `thresholds`）；**#33 `port.call` 路径**由其 bag 传（本轮 trace 内存 + 历史窗口 + thresholds）。服务不读投影（D8），产七类证据（2026-09-20 修订）：

| 证据类 | 判据 | 提案方向（**本插件只标注、不提案**） |
| --- | --- | --- |
| `failure_cluster` | 同 `(code, attributable_to, workspace_id[, contract_id])` 出现 ≥ N 次 | 见下「聚类键」 |
| **`post_failure`** | 某 `contract_id` 的 `trace` 里 `verdict:'fail'` 占比超阈 | **该 Scope 的 `post` 或提示词有问题**：先查 `post` 是否过严，再考虑拆 Scope |
| `cost_anomaly` | 某 `contract_id` 的四维用量中位数超基线 × 倍数 | 换绑定（模型 / 解码）或拆 Scope |
| `instance_drift` | 某 `node_id` 滚动成功率下界跌破转正时基线 | 隔离该实例 / 换绑定 |
| `fold_candidate` | 同一子路径连续 ≥ k 个回合**回合级成功** | 折叠为 composite Scope |
| `no_progress` | 同一 Scope 反复 `l1_maxed:true`（打满 L1 迭代上限） | **拆分该 Scope**，不是加能力 |
| **`verify_failure`** | 某工作区的 `verify` 报告反复 `passed:false`，且失败详情聚类集中 | **近 oracle 信号**：指向具体能力缺口（不是编排问题）；`scope:workspace` 专属实例或新契约 |

- **`post_failure` 与 `failure_cluster` 的区别**：后者按**拒绝码**聚类（节点"拒绝做"），
  前者按**`post` 不过**聚类（节点"做了但没做好"）。两者归因方向不同——前者常指向编排选错 Scope，
  后者常指向 `post` 过严或提示词不当。种子图加强后四个实质 `post`（assemble / step / dispatch / verify）
  使这一类证据**从第一天就有来源**。
- **`verify_failure` 是本设计里唯一接近 oracle 的信号**：`verify` 跑的是工作区自己声明的校验命令
  （如 `cargo test`），`passed:false` 是**客观失败**而非过程指标。它只覆盖"配了校验命令的工作区"，
  但覆盖到的场景里，它的证据质量高于其余所有类别。

- **成本异常的基线**：同 `contract_id` 在本工作区的历史中位数（不是手写数字）；基线随窗口滚动，存 ③ 缓存、可重算。
- **`no_progress` 是本插件的产物、不是运行时拒绝码**：解释器看不到 Scope 内部迭代（L1 在一次 eff 内），
  让 Scope 自己判又破「不能自己决定完成」⇒ 运行时不拦，靠 `trace.l1_maxed` 事后聚类。
  **代价明写**：那一轮该花的钱照花；可接受——成本已由 `retry_policy` 迭代上限封顶，损失有界。

### 聚类键（四维，`workspace_id` 是必须的分区维）

```
cluster_key = (RefusalCode, attributable_to, workspace_id, contract_id?)
```

- **`(码, 归因)` 是主维，不是 `contract_id`**：按契约分组只能回答"哪个契约差"，
  回答不了"**缺什么能力**"——而后者才是契约扩展提案的依据。
  `attributable_to='graph'`（如 `capability_mismatch`）指向**编排选错了 Scope** ⇒ 提案方向是改提示词/改接线；
  只有 `='node'` 且**跨多个 `contract_id` 重复出现**才是**新能力**的证据。
- **`attributable_to='user'` 单独成簇、不产能力缺口证据**：用户拒批 20 次是**偏好**不是能力缺口。
  少这一维会把审批拒绝聚类成"能力缺口"并触发一串无谓提案——这是产品域最容易踩的误诊。
- **`workspace_id` 必须分区（两档聚合，写死）**：

| 档 | 条件 | 可支撑的提案 |
| --- | --- | --- |
| 工作区内 | 某 `(码,归因)` 在单一工作区达阈 | 只能提 **`scope:workspace`** 的专属实例 / 人格 |
| 跨工作区 | 同一 `(码,归因)` 在 ≥ `min_workspaces` 个工作区**独立**出现 | 才可提 **`scope:global`** 的结构改动 |

  ⇒ **通用改动需要跨项目证据，专用改动只需单项目证据**。
  这条同时兑现 #33 的「图通用、专门化落实例」口径：单项目证据推不动通用结构。
  不分区的后果：Rust 项目与前端项目失败模式混聚 ⇒ "能力缺口"其实是"项目特性不同"（`docs/plans/agent-graph-design.md` §10.3 问题 4）。

---

## `sweep`（轨迹清理，宿主周期触发）

- 读 `trace` 窗口 + `verdicts` 引用集 → 产**清理计划**（写新索引、不含过期条目）。
- **不动被 `verdict` 引用的轨迹**（否则 `verdict → proposal → evidence → trace` 溯源链断，#43 验收 3 失效）。
- 保留回合数读 #33 `thresholds`；`sweep` 由**宿主周期触发**（周期住本插件 schema，D6；`host.md` §五 定时触发「调指定命令 / 方法」），清理只动索引，**def 仍在链上**（① 档既定代价，不是删除）。所需 `#43` `trace` / `verdicts` 投影片段由宿主按 `schema.periodic.reads` 机械注入 bag（服务不读投影，D8）（2026-09-20 修订）。
- 与 **#23 `memory-consolidate` 同路**（同一套"写新索引不含旧条目"的手法），但两者各管各的身份，不互相调用。

---

## `record`（user_request 证据生产者，v1 闭环）

- `record(user_message_def, workspace_id)`（**经 #27 的「能力类工具绑定」暴露**——工具名 `record` 直绑本插件能力类方法，**无需 `describe`/`invoke`**，D2）：把用户原始消息 def 落成一条 `class:'user_request'` 证据写计划（`put(证据) + put(新 evolution body) + add_gen`），返回 `evidence_id`。纯计算、不调模型、不发 eff。**`user_message_def` 由 #33 在派发时注入**（interpret bag 含本回合首条用户消息 def——模型不知哈希、服务不自读；2026-09-20 定案）。
- **为什么是 #44 而非 #45**：#45 分签红线「只产提案不产证据」；user_request 是**一等证据**（`class:'user_request'`），归证据层（#44）生产，#45 只引用 `evidence_id`。这保证"用户请求与自主提案走同一通道、同一门禁"且**机械可验证**（#45 输出永远不含证据）。
- agent 流程（用户驱动结构变更）：用户说"加工作流" → agent 经 #27 调 `record`（落 user_request 证据）→ 拿 `evidence_id` → 调 #45 `propose`（带该 `evidence_id`）。

## `shadow`（影子回放，门禁第二道，v1 闭环）

- 入参 = 候选新图 def + #43 `trace` 窗口（含 `directives_summary`/`ctx_summary` + **`eff_log`**）+ `EffectAudit`（**经保留能力类 `host` 的 `audit { filter:{run?}, limit? } -> { records, truncated }` 读取**，D7；`records` 与入站 `audit` 同形；**分批按 `filter:{run}` 取，防 100/1000 上限截断**）；纯计算、零 token、不发 eff（2026-09-20 修订）。
- 据**新图**重新构造等价 `directives` + `ctx`（用 `directives_summary`/`ctx_summary` 作锚，重放新图的解释器逻辑至各 `eff` 点），按 `(port, method, args_hash)` 与 **#43 `trace.eff_log`** 配对回灌结果（`host.audit` 读 `EffectAudit` 保留为**补充**）；**不调任何真实端口**（2026-09-20 修订）。
- 出 `shadow` 指标：`pass`（所有 eff 都有匹配审计且结果一致）/ `fail`（结果不一致）/ `unverified`（有 eff 无匹配审计——历史未跑过该路径）。
- 写进 `verdicts.gate.shadow`（经 #33 落账，本插件不写链）。
- **分签红线不变**：`shadow` 产的是**门禁 gate 输入**（pass/fail/unverified），不是 `evidence`、不是 `proposal`——它是纯计算的对账，与证据/提案职责不重叠。

## 纯计算纪律

- **不取时间、不用随机**：`now` 由 bag 传入（与 #26 / #19 同规），保同输入同输出。
- **不 eff 世界身份**（唯一 pin = 保留身份 `host`；`shadow` 经 `host` + `audit` 读审计，属反向方法调用、不入世界）：只读投影 + 纯计算 + 返回计划。
- **发 `event`（orchestration.unhealthy）**：`aggregate` 读 `trace` 投影，若**最近连续 N 次以 `refused` 收口**（N 读 #33 `thresholds`），#44 服务发 `orchestration.unhealthy` 事件（经宿主透传 → #38 始终通知、#17 S13 横幅）。**与 #17 健康判定同口径**（#17 也数连续 `refused` 收口，见 `plugins/ui-settings/DESIGN.md`「健康判定与回滚」）；这是**数据变化的机械通知**，非业务判定，符合 `protocol.md` §2.5（服务可发 event）。
- **缓存走宿主侧 ③**（`state/plugins/evolve-metrics/`）：基线与滚动统计可重算、可 GC，丢失只影响一次重算。
- **服务无写通道**：一切写经计划通道交 #33 落账（`draft-design.md` §1.2 第 5 条）。

---

## 跨插件登记

- **#33 loop-policy**：pin 本插件；`aggregate` 触发 = **宿主周期（主）+ #33 回合尾 `port.call`（可选路径，bag 由 #33 装配：本轮 trace 内存 + 历史窗口 + thresholds）**；`sweep` 由**宿主周期触发**（周期住本插件 schema，D6），**不经 #33 周期 eff**；本插件读 #33 `thresholds`（连续 `refused` 收口阈值）判 `orchestration.unhealthy`。**本插件不反向依赖 #33**（投影读，避免成环）（2026-09-20 修订）。`evolve.propose` 的证据来自**已落账** #43（#33 **下一回合**读——off-by-one 已消，呼应 `loop-policy` 7.1）。
- **#43 evolution**：投影读 `trace`；产 `evidence` 与清理计划写回。
- **#45 orchestration-admin**：消费本插件产的 `evidence`（经 #43 投影），产提案。**两者不互相调用**（分签）。
- **#17 ui-settings S13**：`orchestration.health` 降为**只读视图**（读 #43/#44/#33 投影），不再是 `orchestration.unhealthy` 的 emitter；本插件发该事件。
- **#38 ui-notify**：订阅本插件发的 `orchestration.unhealthy`（始终通知，不依赖用户打开 S13）。
- **宿主保留身份 `host`（D7）**：`shadow` 的**主配对源 = #43 `trace.eff_log`**（按 `(port,method,args_hash)` 配对回灌）；`host.audit {filter:{run?}, limit?}` 读历史 `EffectAudit` 作**补充对照源**（分批按 `filter:{run}` 取）；本插件不读世界本体、不发 eff（`host` 是保留身份、不在世界，`pins:{"host":"host"}` 解析回自身）。
- **宿主能力（H4 已落地）**：插件 ③ 目录（`state/plugins/<id>/`，与 #21 向量索引同路）——本插件复用。
