# #45 `orchestration-admin`（agent 面编排管理）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 45 / `orchestration-admin` |
| 职责 | agent 面编排管理：`list` / `read` / `validate`（本地复刻 #33 机械闸 dry-run）/ `propose`；**只产提案条目、不产写** |
| 依赖 | pins 无；`+` 33（投影读六类条目）、43（投影读证据与台账）、11 / 41（经投影解析当前 `workspace_id`）；`<-` 27（pins：以工具类 `orchestration-admin` 暴露给 agent） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["orchestration","orchestration-admin"]`，`methods: {orchestration:["list","read","validate","propose"], "orchestration-admin":["describe","invoke"]}`（工具类名 = 身份名，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」）。**`orchestration` 类 = 管理 API**（服务方法），v1 唯一消费者 = 本插件工具类 `orchestration-admin.invoke`（按工具名内部派发，即 #27 的调用入口）；图内不直接 `port.call` 该管理类（如需属后置，D15） |
| 命令 | 无 |
| schema | `schema/orchestration-admin.json`（**仅私有参数：允许的变更类**；提案条数上限 / 提案大小上限 / diff 上限读 #33 `thresholds`，本 schema 不重定义，D14；**非安全参数**） |
| 机制 | 见下 |
| 边界 | **不产证据**（分签红线）/ **不直接写图**（只产提案）/ 不改插件源码（归 #42）/ 不做门禁判定（机械闸归 #33 的 term、影子回放归 #44、人闸归 #32/#39）/ 不做装配与换代（归宿主） |
| 验收 | 1) **输出里不含证据**（机械可查：只产 `kind:'proposal'` 条目）；2) `propose` 的 `evidence_ids` **必填非空**，缺证据直接拒；3) `validate` **本地复刻 #33 机械闸 dry-run**（已知实现重复）、返回结果哈希；4) `propose` 必须携带上次 `validate` 的结果哈希；5) 提案一律 fork-only（带 `derived_from`），空白整图被拒；6) 用户请求与自主提案落**同一 tail、过同一门禁**（无旁路写，机械可查）；7) 换 #33 实现不改本插件 |
| 状态 | 新增（2026-09-19，agent 图与自进化）：完整设计见 `docs/plans/agent-graph-design.md` |

> **分签红线（结构性）**：本插件**只产提案、不产证据**；#44 `evolve-metrics` **只产证据、不产提案**。
> 两层用 `evidence_id` 连接。给本插件加产证据的能力就等于"**自己造证据支持自己的提案**"，
> 评审再也无法机械验证。这是从实验借用的五条之一。

---

## 机制

| 方法 | 做什么 | 产出 |
| --- | --- | --- |
| `list(bag)` | 列当前 active 图的 Scope 概览（`node_index` / `contract_id` / `impl` / `scope` / `autonomy` / `links` 摘要）+ 契约清单 + 阈值表 | 只读数据 |
| `read(bag)` | 读某条目全文（契约 / Scope / 图 / 阈值）+ 关联证据摘要 | 只读数据 |
| `validate(bag)` | **本地复刻** #33 的机械闸 dry-run（六条图不变量 + 四条演化规则 + 闭合 / 类型 / publish 偏序 / 端口 ⊆ pins；不 eff #33）；返回错误列表与**结果哈希** | 校验结果 + 哈希 |
| `propose(bag)` | 构造**提案条目**写计划（`put(提案) + put(新 evolution body) + add_gen(evolution)`） | **提案条目，不是图变更** |

**`propose` 的四条硬约束**（写期机械校验，不满足直接拒）：

1. **`evidence_ids` 必填非空** —— 禁时钟驱动生长。**用户请求也算证据**：由调用方先经 #44 `record`（证据层）落一条
   `class:'user_request'` 证据（带原始消息 def 哈希，**生产者 = #44，非本插件——保分签**），再引用它 ⇒ 用户请求与自主提案**同一通道、同一门禁**。
2. **fork-only** —— `patch` 里的新图必须带 `derived_from`（当前 active 图 def 哈希），**禁空白整图**。
3. **`validate` 前置** —— 必须携带上次 `validate` 的结果哈希（同一 bag / 同一 patch），否则拒 `validate_required`。
4. **额度** —— 每回合提案条数与 diff 大小受 #33 `thresholds` 上限（D14；用户显式请求**不占额度**，但仍逐条过门禁）。

**本插件不判"该不该改"**：它只把提案落成可审计条目。三道门禁在别处——
机械闸（#33 的 term）/ 影子回放（#44 `shadow` 方法，零 token）/ 人闸（#26 判高危 → #32 入队 → #39 裁决）。

---

## 与 #42 `plugin-admin` 的分工（不合并的三条理由）

| | #45（本插件） | #42 `plugin-admin` |
| --- | --- | --- |
| 写什么 | #33 的图数据 | 插件包 `execute/` 源码 |
| 生效 | **热生效**，进程不动 | **代码换代**：新服务 + 握手 + 旧服务 drain |
| 失败 | 回滚 = 一条 `set_active` | **fail-closed 隔离**，绝不回落旧世代 |
| 产出 | **提案条目**（门禁在采纳前拦） | **写计划**（审批闸在执行前拦） |
| 安全语义 | 图六条不变量 | 受保护 `pins` 不可删 + 可见性过滤 |

1. **代价与生效语义完全不同**：塞进一个 `write` 后面挂两套风险，权限档也没法分开配。
2. **安全语义不同**：混在一起两套语义互相污染。
3. **边界冲突**：#42 的边界已写明"装配与换代归宿主"、它不认识图；让它认识 #33 的数据 schema 就是越界。

**一处刻意的不对称（写明理由，别强行统一）**：本插件产**提案条目**、#42 产**写计划**。
根因是**影子回放**——编排变更能用历史输入 + 审计回灌验证（零 token、可复现），
所以需要提案态承载影子指标给人裁决；**源码变更换的是进程、跑不了影子回放**
⇒ 提案态对它没有额外价值，只多一跳。

**两个管理面共同受约束**：① 不得削弱受保护 `pins`；② 不得绕审批段（#33 不变量 4）；③ 都要 `validate` 前置。

**必须明写的限制**：`host.md` **v1 无 op 级鉴权**（term 可产任意 op、宿主不限制改哪个身份）
⇒ "本插件不改源码、#42 不改图"是**工具面约定 + 审批闸**，不是内核强制。要硬强制需要 op 级鉴权，属后置档。

---

## 用户驱动的结构变更（同一通道）

用户说"加一条工作流 / 加个子代理 / 让这个只用于本项目"时，agent 经本插件 `propose`：

| 用户说 | 提案内容 | 生效 |
| --- | --- | --- |
| 加子代理 / 协作者 | `#35` 人格条目 + `#33` 一条 Scope（`impl:atomic`，pin 人格） | 热生效，**不改图**（走 `subagent` 契约） |
| 加工作流 / 子图 | `#33` 一条 Scope（`impl:composite` + `subgraph`）+ 接入顶层图的边 | 热生效（fork + 有限 diff） |
| 某能力专属本项目 | 给 Scope / 人格 / 技能写 `scope:{kind:'workspace', workspace_id}` | 热生效，不改图 |

**门禁三条调整（用户请求下）**：① 机械闸照跑**不放宽**（否则"帮我去掉确认步骤"就是一句话提权、
"帮我串三个模型互检"就绕过 `llm_chain_max`）；② 影子回放照跑但**只呈现不否决**（用户要的东西不该由系统替他拒，
但必须让他看见 token / 步数 / 审批率的 diff）；③ **人闸仍要一次**（对话里说的是**意图**，
不是对具体图 diff 的批准；`auto` 档除外，复用既有四档不新造）。

### 跨身份采纳（触及 #35 / #36 时的写世代口径，D15 补）

提案可能同时触及多个身份：**加子代理** = `#35 agents` 人格条目 + `#33` 一条 Scope；**写技能 `scope`** = `#36 skill`。
采纳**不是只对 #33 图 `add_gen`**，而是一次**多身份批量写计划**：

- 触及身份各自写一代：`put(条目) + put(新 body) + add_gen(<目标身份>)`（`#33` 图世代 + 触及的 `#35` / `#36` 各一代）；
- 由**采纳者（#33，与图外回滚入口同源）**在图外**一次性**提交，审批闸对**整批**生效（不出现"图改了、人格 / 技能没写"的半采纳）；
- `verdict.adopted_gen` 记 `#33` 图世代 seq（主世代）；跨身份的 `#35` / `#36` 世代 seq 记入提案 `patch` 的 `writes[]` 供溯源
  （#43 `verdict` 是否扩列属 #43 版本提升，登记于此）；
- **本插件只产提案、不执行写**；跨身份批次的实际提交在采纳阶段（#33）。

**提案里的写面形状（写死，供 #33 采纳阶段直接展开）**：

```jsonc
// proposal.patch
{ "graph": { "def": "<新 #33 图条目哈希>" },            // 主改动（#33 图世代）
  "writes": [                                          // 跨身份附加写（可为空）
    { "identity": "agents", "payload": { "def": "<#35 新条目/body 哈希>" } },
    { "identity": "skill",  "payload": { "def": "<#36 新条目/body 哈希>" } } ] }
```

- **采纳阶段（#33 服务）**：verdict = `accepted` 时，把 `patch.graph` + `patch.writes[]` 展开成**一条原子 `batch`**：`[add_gen(loop-policy, graph), add_gen(<writes[i].identity>, payload) …]`，交宿主落账（服务无写通道，计划经 #14 入口 term 成为顶层 `$directives`）。
- **整批由审批闸拦**：#32 的 `orchestration_change` 审批对**整批**生效；不出现"图改了、人格 / 技能没写"的半采纳（失败整批回滚，世界逐字节不动）。
- **溯源**：`verdict.adopted_gen` = #33 图世代 seq（主）；`patch.writes[].identity` 的世代 seq 由 #33 落账后回填 #43 `verdicts`（#43 扩列属其版本提升，已登记）。

---

## 纪律

- **服务无写通道**：只返回计划，宿主落账（`draft-design.md` §1.2 第 5 条）。
- **不读世界本体**：只读投影（#33 六类条目 + #43 台账）。
- **同输入同输出**：不取时间、不用随机（`now` 由 bag 传）；提案 id 确定性生成（run + 序号）。
- **不发 eff**（无 pins）：`validate` 是**读投影 + 本地复刻同一套机械校验逻辑**（本地复刻 #33 机械闸 dry-run，**已知实现重复**），不 eff 到 #33
  （#33 的被调方法是 `loop-policy.interpret` 图解释器，不提供 `validate` 方法，D1）。与 #40/#11 附件校验重复同性质
  （白名单 schema 无 `$ref`、无法共享），实现时以 #33 为准。

---

## 渲染（`describe.render`，本轮定）

| 工具 | `form` | `label` | `summary` | `tone` | `detail` |
| --- | --- | --- | --- | --- | --- |
| `orchestration.list` | `card` | `orchestration` | `list` | **`solid`** | `{kind:"list"}`（六类条目摘要） |
| `orchestration.read` | `card` | `orchestration` | `read  {target}` | **`solid`** | `{kind:"json"}`（图 / 契约 / 阈值条目） |
| `orchestration.validate` | `card` | `orchestration` | `validate  {target}` | **`solid`** | `{kind:"json"}`（机械闸 dry-run 结果） |
| `orchestration.propose` | `card` | `orchestration` | `propose  {target}` | **`solid`** | `{kind:"diff"}`（**图 diff + 影子回放指标对比**） |

- **高危写类用 `solid`**：默认收缩显示 `op + target`，展开看图 diff 与影子回放指标对比。
- `orchestration.propose` 卡片在**门禁 / 采纳前**就出现；采纳由 #33 对自身图数据世代 `add_gen`（跨 #35/#36 见「跨身份采纳」），卡片状态角标随之更新。

## 跨插件登记

- **#33 loop-policy**：本插件投影读其六类条目；机械闸规则以 #33 为准（本插件**本地复刻 dry-run**，已知实现重复）；
  采纳后由 #33 对自身图数据世代 `add_gen`（跨身份见「跨身份采纳」）。**本插件不 pin #33**（#33 的 `loop-policy.interpret` 不被本插件调用）。
- **#43 evolution**：提案落其 `proposals` tail；`evidence_ids` 引用其 `evidence` 条目。
- **#44 evolve-metrics**：消费其产出的证据（经 #43 投影）；**两者不互相调用**（分签）。
- **#27 tools**：本插件以工具类 `orchestration-admin` 暴露，#27 pin 本插件并纳入工具目录（与 #42 同路）。
- **#26 guard / #32 approval / #39 ui-approval**：**实际派发键 = (port `orchestration-admin`, tool `propose`)**（2026-09-19 口径对齐；不再写作方法式 `orchestration-admin.propose`，D15）判高危 ⇒ `escalate` ⇒
  入审批队列，item `kind = orchestration_change`（摘要 = 图 diff + **影子回放指标对比**）。
- **#17 ui-settings S13**：人可见的编排页**只读**，图变更不经本页、只经本插件提案 + 审批。
- **#42 plugin-admin**：分工见上；两者共用三条约束。
