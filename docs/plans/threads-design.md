# 线程设计（子代理 / 协作者 / 工作流）

> 补四个缺口：**线程**（数据模型）/ **进程**（并发）/ **上下文**（每线程组装）/ **渲染**（顶栏 + 视图）。
> **本轮决策（2026-09-19）**：
> ① **真并发**（改宿主：run 级并发 + 提交队列 + 乐观校验；内核 `run` 语义不变）；
> ② 顶栏 = 新插件 **`#46 ui-threads`** + 新 slot `topbar`；群聊 / 步骤卡**并入 #18** 按线程 kind 分派；
> ③ **子代理上下文** = 常规组装 − 「上一会话 L1」+ **父线程几条摘要** + **父 agent 任务提示词** + 人格 `system_prompt`（**不继承父线程消息历史**）；
> ④ **协作者 ≠ 子代理**：协作者 = **圆桌群聊讨论**（多参与者共享群聊 transcript）。

---

## 一、线程模型（数据）

**Thread = #11 会话 + 新字段**（版本提升 #11）：

```jsonc
{ "kind": "main" | "subagent" | "group" | "workflow",
  "parent": { "def": "<父会话 id / 哈希>" } | null,     // 线程树
  "agent":        { "def": "<#35 instance 条目哈希>" },  // subagent：人格
  "participants": [{ "def": "<#35 instance 哈希>" }],   // group：圆桌参与者
  "workflow": { "graph": { "def": "<#33 图哈希>" }, "node_index": 0, "iter": 0 } }  // workflow：关联的图执行位置
```

- 默认一条 `main`；子线程靠 `parent` 组成**线程树**。
- **标题沿用会话标题**（#11 `rename` / 自动标题）——顶栏标签直接用它。
- 线程列表 = #11 会话列表（已有）加 `kind` / `parent`；**不新增身份**（线程是会话数据，不是插件）。

---

## 二、进程与并发（真并发，内核 + 宿主改动登记）

- **并发单位 = 线程**：每线程有自己的 run 序列；**多个 run 同时活动**。
- **单 pending 不变**：每个 run 内部仍是单 pending（eval 内不并行）——并发**只在 run 之间**，不动 `kernel.md` §十二「单 pending 是严格求值下界」。
- **提交串行（写死）**：所有 run 的 `commit` 进**单一提交队列**，按**宿主仲裁序**落账。
- **仲裁序 = journal 链序**（不新增字段）：提交队列串行出账，每条 `commit` 落账即得一个 `seq`，链序**就是**仲裁序——回放按 `seq` 重放即按仲裁序重放，**无需在 `Entry`/`Op` 上加新字段**（`seq`/`prev` 已承载）。
- **乐观并发**：提交时校验 base `worldRev`（或目标身份 rev）；冲突 → 宿主把该 run 的 `directives` + 已回灌 `results` 原样重提交（**同 `run_id`、同 `now`、`results` 只增不改**，复用 `kernel.md` §十二 续跑纪律），重试即占一个新 `seq`、入账可辨。
  - defs 内容寻址 ⇒ 不同 def 的并发 `put` 天然可交换；**冲突面只在共享身份的 body**（#11 会话列表、#1 input、#21 记忆索引、#33 图数据）。
  - 每线程写自己的会话链 ⇒ 大部分提交零冲突。
- **`#1 input` 争用（写死）**：`#1` 原为全局单值寄存器，并发线程同时写会丢失。**版本提升 #1**：body 改为 **per-thread 键控**——`body = { slots: { "<thread_id|_main>": <slot> } }`；写类命令携带 `thread_id`，写自己的键、读自己的键 ⇒ 不同键的 `put` 可交换、无丢失更新。`#2 config` 是用户级（一用户一份），并发线程共享只读，写（主题/侧栏宽度）罕见且 last-write-wins 可接受，**不分区**。
- **可回放**：回放按账里的提交序（`seq`）重放；并发期间的 LLM / 工具结果都在账里 ⇒ 逐字节等价（与「LLM 不确定、审计回灌确定」同口径）。
- **宿主改动（登记，提出方 = 本设计；落 `host.md` §五 写者）**；内核只登记、**不改 `run` 语义**（`kernel.md` §十二）：
  1. 「单写者锁」从「run 全程持有」**收窄为「commit 期间持有」**——run 可并发推进 eval / 等待效果，只在落账那一刻串行；
  2. 支持 **run 级并发**（多个 eval 推进同时活动）；`expect_pos` 的单链头 CAS 天然支持乐观并发提交（`kernel.md` §十四 边界 5 不变——仍是单链、不做多链合并）；
  3. **乐观提交校验 + 冲突重试**（重试即新 `seq`，入账可辨；复用续跑纪律同 `run_id`/`now`/`results`）。
  > **不改 `Op`/`Entry` 形状**：仲裁序 = `seq`、续跑 = 既有 `waiting`/`results` 台账、冲突检测 = 既有 `expect_pos`/`worldRev`。三条复用既有字段，无新 op。
- **既有先例**：审批往返（#32）已把「跨 run 挂起 / 续跑」做成机制；本设计是它的**并发扩展**，不是新范式。

---

## 三、上下文（每线程独立组装，口径写死）

| 线程 | 组装输入 |
| --- | --- |
| `main` | 常规（#13 全切片：系统提示 / 工具 schema / L2 / 上一会话 L1 / 本会话 L1 / 技能 / 召回 / 历史 / 风格） |
| `subagent` | 常规组装，但**去掉「上一会话 L1」**；额外加 **父线程的几条摘要**（父会话 L1 的最新 N 条）+ **父 agent 的任务提示词**（一条 user 消息）+ **inbox 未读消息**（父指令 / 裁决）+ 人格 `system_prompt`（#35 instance）；**不继承父线程消息历史** |
| `group` | **群聊 transcript**（带发言者名）+ 本轮发言者人格 + 圆桌议题（父线程给的 spec）；每个参与者**各自独立组装** |
| `workflow` | 图 `shared` / slots（#33），**不是消息历史**；步骤卡数据来自图执行状态 |

- **子代理 ≠ 协作者（写死）**：子代理 = **agent 的助手 / 子线程**（隔离：父摘要 + 任务提示词 + 人格，**单轮委派**）；协作者 = **圆桌群聊**（多参与者共享群聊 transcript、**开放讨论**）。
- **子代理拿不到父线程消息历史**：要上下文就由父线程写进**任务提示词**或**摘要**（显式、可控、省 token）。
- 记忆：子代理 / 群聊要记东西**显式落 #21**（带 tag + scope），不自动继承。
- #13 新增 bag 字段：`bag.parent_summaries[]` / `bag.task_prompt` / `bag.thread_kind` / `bag.inbox_unread[]`（由 #33 的 `context.assemble` 阶段写）。

### 子代理线程的实测口径（2026-09-19，按真实子代理行为校准）

**实测**（spawn 一个子代理并令其自述可见上下文）：子代理**看不到**调用方的会话历史、调用方处境、调用方人格；**看得到**自己的指令 / 人格、可用技能、项目长期记忆、以及调用方给的这一条提示词，加上环境块（工作目录 / 时间）。**它收不到后续消息**——单条最终消息就是全部产出。

据此定死子代理线程的五条：

1. **全新上下文**：组装输入 = 人格 `system_prompt`（#35）+ **任务提示词**（自包含）+ **父线程几条摘要** + **本线程 inbox 的未读消息**（父的指令 / 裁决）+ 技能（#36）+ 长期记忆（#21，按 scope 过滤）+ 环境（工作区 / 时间由 bag）；**不含父会话消息历史、不含「上一会话 L1」**。
2. **委派 + 可中途引导**：父给**自包含**任务提示词（目标 / 必要背景 / 边界 / 期望产出形态）；子跑起来后父**仍可发指令**（写进子 inbox，子下一轮组装读到 ⇒ 运行中生效）；父可**看子处境**（`thread.status`）；子可**向父发消息**（如 `decision_request`），父回 `decision`。
3. **默认只回最终报告**：子完成 → **只写一条 `report`**（最终消息）进父 inbox；**不自动传全量 transcript**。要看全量去子线程（顶栏点进去）——这就是"通信共享但不自动传所有"。
4. **中间过程只在本线程可见**：父线程默认只拿最终报告；子代理的工具调用 / 推理轨迹留在**子线程**里（不污染父线程上下文与展示）。
5. **不扩权**：子代理能用哪些工具由 **#33 契约的 `effects`** 决定（#35 已写死"加子代理不会扩权"），人格只提供 prompt / model / decoding。

### 父子通信与生命周期（通信共享，本轮补）

> 这一段把 `docs/plans/agent-graph-design.md` §7.8 里标注"后置"的**实时协作**补上——并行已由 §二 的 run 级并发解决，投递按下列口径落地。

- **传输必须落世界**（§7.8 推论 1）：slots / shared 住 eval `args`、run 一结束就没了 ⇒ 跨线程消息只有一条路：**写进世界**。
- **载体 = 目标线程的 `inbox`**（#11 会话 body 加 `inbox: {tail,count,last_seen}`，条目各自成 def + 链式 `tail`）：
  - 消息形状：`{ id, from: <thread_id|"user">, to: <thread_id>, kind: "instruction"|"report"|"decision_request"|"decision", body, refs?, at, seq }`。
  - **并发写安全**：追加是**可交换**的（每条以当前 `tail` 为 `prev`），冲突由 §二 的**提交队列 + 乐观重试**化解——不需要多写者锁，也不需要 per-writer 分链。
  - **读**：目标线程 `context.assemble` 时投影读自己 inbox，把 `seq > last_seen` 的未读消息作为**独立切片**注入（`instruction` / `decision` 作 user 消息；`report` 作子线程结果）。
- **父 → 子**：`thread.send {to, kind:"instruction", body}` —— 运行中生效（工具循环每轮重组装）。
- **子 → 父**：`thread.send {to: parent, kind:"decision_request"|"report", body}` —— 决策请求会**唤醒**父线程（宿主按 resume 游标触发新 run，同 #32 机制）。
- **默认回传**：`report` 只一条（最终消息）；全量 transcript 留在子线程。
- **处境观察**：线程 body 加 `status`（`running` / `waiting` / `blocked` / `done` / `failed` / `terminated`）+ `last_activity`（`at` + 一句摘要）+ `pending`（待裁决 / 待审批）；父 `thread.status` 读投影即得（UI 同时订阅 `thread.updated` 事件）。
- **恢复**：子崩溃 / 断连 → `thread.resume`（按子线程的 **resume 游标**续跑，复用 #32 的跨 run 机制；不重头跑、不回溯已落账）。
- **强制终止**：`thread.terminate` → `cancel{run}` + `status:"terminated"`；已落账不回溯、后续消息不再注入。

**控制面归属（写死，2026-09-19 修正：避免宿主越界）**：
- **`thread.send` / `thread.status` → `#11 session` 服务**（#11 有 execute、是线程数据 owner）。`thread.send` 经 #27 以工具名 `subagent.send` 派发 → #11 `deliver(to, kind, body)` 返回**写计划**（put 消息 def + 更新目标线程 `inbox` tail + 写目标线程 `status`/`last_activity`/`pending`）→ 宿主机械落账；**#11 服务在 commit 落账后发对应 `event`**（`thread.updated` / `thread.closed` / `workflow.step` / `group.message`，见 §四）。`thread.status` 是 #11 投影读（term，无服务调用）。**宿主不直造 #11 body**（保 `host.md` §一「载体不认识业务」+ §六不变量 7「声明驱动」）。
- **`thread.resume` / `thread.terminate` → 宿主面**（run 生命周期，与审批 resume 同源）：`resume` 按子线程 resume 游标触发新 run；`terminate` = `cancel{run}` + `status:"terminated"`。经 #27 以工具名 `subagent.resume` / `subagent.terminate` 暴露给 agent，#27 把工具调用转交宿主面（宿主作为「宿主能力类」工具提供者，不占插件编号）。
- **`orchestration.unhealthy` → `#44 evolve-metrics` 服务发**（#44 有 execute、**周期（宿主定时触发）`aggregate`** 时产 `failure_cluster` 证据，超 #33 阈值即发该事件；#17 S13 `orchestration.health` 降为只读视图，不再是 emitter）。
> 为什么 send/status 不放 #33：`#33 loop-policy` 是**图解释器**（服务自驱），**不持有线程数据**；`thread.send` 要写目标线程 `inbox`/`status`，只有线程数据 owner **#11 `session`** 能产出该写计划。`deliver` + 发 event 是数据变化的通知，非业务判定；run 生命周期（resume/terminate）归宿主保留能力类 `host`。

### 协作者（圆桌群聊）与子代理的分野（写死）

| | 子代理（subagent） | 协作者（group） |
| --- | --- | --- |
| 形态 | **子线程**（隔离、委派） | **圆桌群聊**（共享 transcript、开放讨论） |
| 上下文 | 父摘要 + 任务提示词 + 人格；**无父历史** | **群聊 transcript** + 本轮发言者人格 + 议题 |
| 交互 | **可中途引导**（父发 `instruction`）、**可发 `decision_request`**；默认只回最终 `report`；父可 `status` / `resume` / `terminate` | 多轮轮流发言，人可旁观 / 插话 |
| 产出 | **一条最终 `report`** 回灌父线程（全量留在子线程） | 群聊消息追加，讨论收敛后由聚合契约（`vote` / `judge` / `merge`）收敛 |
| 渲染 | 普通对话（顶部显示人格名 + 「由 X 触发」） | **群聊**（发言者头像 + 名 + 气泡） |

---

## 四、渲染

### 顶栏（新 slot `topbar`，新插件 `#46 ui-threads`）

- **位置**：侧边栏右侧、`main` 顶部；**鼠标悬浮显示、离开隐藏**（不占常态高度，hover 时 overlay 展开）；**hover 意图延时 150ms 出 / 300ms 收**（防误触），层级 `--z-topbar`（ui-design §16.11）。
- **标签**：默认「对话」→ 会话标题更新后变**会话标题**；开子代理 → 追加**「子代理会话标题」**标签，点进切到子代理对话；群聊 / 工作流各一个标签。
- **激活标签 = 当前 main 区显示的线程**；切换经 **`api.uiState`（`active_thread`）** 跨 slot 同步（UI 插件互不 pin，见 ui-design §15）；世界/状态派生数据仍走宿主事件。
- 线程状态角标：运行中（呼吸点）/ 待审批（warning 点）/ 完成 / 失败。
- **已知例外（ui-design §11.10 / §14）**：顶栏为**纯 hover 交互，键盘不可达、触屏不可用**（2026-09-19 用户定）。

### main 区按 `kind` 分派（并入 #18）

| `kind` | 渲染 |
| --- | --- |
| `main` / `subagent` | 普通对话（现有消息流；子代理顶部显示人格名 + 「由 X 触发」） |
| `group` | **群聊**：每条消息带**发言者首字母圆标 + 名 + 气泡**（§8 禁彩色 / emoji，故不做彩色头像）；参与者消息与「我」的消息分区；圆桌顺序轮转，当前发言者圆标呼吸 |
| `workflow` | **步骤卡**：当前步骤 + 进度 + 状态；展开为**只读节点列表**（**非图形化图**；结构性回滚在 #17 S13） |

> 细节（首字母圆标 / 轮转 / 未读锚点 / 步骤卡失败重试）见 `plugins/ui-chat/DESIGN.md`「线程视图」。

- **一插件一 slot 不破**：`main` 槽仍归 #18，群聊 / 步骤卡是它的**kind 分派**，不是新 slot。

### 事件（#11 / #44 服务发，宿主透传，不进世界）

`thread.opened` / `thread.updated`（标题 / 状态）/ `thread.closed` / `workflow.step`（步骤卡实时更新）/ `group.message`（群聊增量）——**emitter = #11 session 服务**（commit 落账后据 body 变化机械发：新会话→`opened`、标题/`status`/`inbox` 变→`updated`、关闭→`closed`、工作流节点推进→`workflow.step`、群聊追加→`group.message`）。`status` / `last_activity` / `pending` 由 #11 `deliver` / `commit` 顺带写（数据变化 ⇒ 事件）。`last_seen` 游标由 #11 `deliver` / 目标线程 `context.assemble` 读后写回（投影读后落账，下轮不再注入已读消息）。
`orchestration.unhealthy` —— **emitter = #44 evolve-metrics 服务**（**周期 `aggregate`** 产 `failure_cluster` 证据超 #33 阈值即发；不依赖用户打开 S13）。

---

## 五、新插件 `#46 ui-threads`（顶栏）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 46 / `ui-threads` |
| 职责 | **线程顶栏**（slot `topbar`）：按 #11 会话列表（含 `kind` / `parent` / 标题）渲染标签；hover 显示 / 离开隐藏；点击切换当前线程 |
| 依赖 | 无 pins；`~` 14（读会话列表 / 标题）；`+` 47（投影读待办清单）、11（投影读线程字段 `kind` / `parent`）；**投影读在入口 term，经只读命令 `threads.state` 触发**；收宿主事件（`thread.*` / `workflow.step` / `group.message`，emitter = #11）；跨 slot 视图态经 `api.uiState`（`active_thread`）；`<-` 15（挂载 topbar） |
| 成员 | execute（前端 entry.js）, terms（只读命令 `threads.state` 入口 + 投影读；UI 服务不读投影、入口 term 可读，见 ui-design §15） |
| 能力类·方法 | `implements: ["ui-threads"]`，`methods: {"ui-threads":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | `threads.state`（无参；入口 term 投影读 #11 线程字段 + #47 待办清单，返回标签数据） |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 顶栏标签 = 线程列表；激活态与切换经 `api.uiState`（`active_thread`）；hover 展开 / 离开收起（overlay，不推挤布局） |
| 边界 | 不做：对话渲染（归 18）/ 群聊与步骤卡（归 18 按 kind 分派）/ 判定 / 写世界本体（写走入站面）/ 无 pins 不发 eff |
| 验收 | 1) 默认「对话」标签；2) 标题更新后标签跟随；3) 开子代理 / 群聊 / 工作流后标签出现、点击切到对应视图；4) hover 显示、离开隐藏、不推挤布局；5) 崩溃不影响 main / sidebar |
| 状态 | 新增（2026-09-19，线程设计） |

---

## 六、跨插件登记

- **#11 session（版本提升：被提升方）**：会话加 `kind` / `parent` / `agent` / `participants` / `workflow` 字段，以及 **`inbox`（线程收件箱）** / `status` / `last_activity` / `pending`（处境）；**新增能力类方法 `deliver`**（`subagent.send` 工具入口，写目标 inbox + status；commit 后发 `thread.*` / `group.message` / `workflow.step` 事件）；`last_seen` 由 `deliver` / `assemble` 读后写回。`#1 input` 版本提升：body 改 per-thread 键控（`slots[<thread_id>]`，并发无丢失更新，见 §二）。
- **#13 context-window**：按 `bag.thread_kind` 调组装输入——`subagent` 去「上一会话 L1」、加 `parent_summaries` + `task_prompt` + **inbox 未读消息**；`group` 用群聊 transcript；新增 bag 字段。
- **#15 ui-shell**：布局新增 **`topbar`** slot（侧边栏右侧、main 顶部；hover overlay）。
- **#18 ui-chat**：按 `kind` 分派 对话 / **群聊** / **步骤卡**。
- **#27 tools**：以工具名暴露线程控制 —— `subagent.send` / `subagent.status`（`send`/`status` 派发到 #11 `deliver`/投影读）；`subagent.resume` / `subagent.terminate` 转交宿主面（宿主作为「宿主能力类」工具提供者）。另（2026-09-19 补登记）#27 新增 `evolve-metrics` pin 暴露 #44 `record`（见 `plugins/evolve-metrics/DESIGN.md`）。
- **#33 loop-policy**：`subagent` / 协作契约在 **run 级并发**下执行；`context.assemble` 写 `bag.thread_kind` / `parent_summaries` / `task_prompt` / **`bag.inbox_unread`**（本线程 inbox 未读消息）；子发 `decision_request` 时**唤醒父线程**（按游标触发新 run，同 #32）；工作流状态供步骤卡。**本插件不提供线程控制**（线程数据 owner 是 #11、run 生命周期归宿主 `host` 能力类，见 §三 控制面归属）。
- **#35 agents**：子代理人格 / 圆桌参与者取 instance 条目（`system_prompt` pin）；**`channels`（跨回合留言板）与 `inbox`（线程收件箱）分工**：前者是"写进世界、下一回合读"的通用留言板，后者是线程收件箱（父子消息专用、带 `kind` 与未读游标）。
- **#32 approval**：并发下审批往返仍是既有跨 run resume 机制。
- **#44 evolve-metrics**：**周期（宿主定时触发）`aggregate`** 产 `failure_cluster` 证据超 #33 阈值时发 `orchestration.unhealthy` 事件（#38 始终通知，不依赖用户打开 S13）。
- **宿主能力（已落地）/ 内核改动**：run 级并发 + 提交队列 + 乐观校验（H12，见 §二）；**线程控制面** `thread.send` / `thread.status` / `thread.resume` / `thread.terminate`（H9，见 §三）。
