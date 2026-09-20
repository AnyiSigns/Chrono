# #19 `compress`（压缩引擎：摘要 / 上下文压缩 / 抽取）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 19 / `compress` |
| 职责 | **压缩引擎**（上下文与记忆共用），三种压缩：`summarize`（会话摘要 → L1）/ `compact`（上下文压缩，75% 触发）/ `extract`（从压缩产物抽 2–3 条 → L2） |
| 依赖 | `->` 12（pins：`semantic` 模式调模型）、20（pins：`summarize` / `extract` 产出去重用向量，2026-09-19 补——原只写「+ 读」未声明 pin，#20 是执行件、投影读替代不了调用）；`+` 3、11（读现有记忆与会话）；`<-` 33（回合管道 / 编排触发）、27（记忆工具派发，见下）、23（`memory-consolidate` 固化需要 `summarize` / `extract` 的摘要产物） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["compress"]`，`methods: {compress:["summarize","compact","extract"]}` |
| 命令 | 无（触发者：33 管道 / agent 经记忆工具） |
| schema | `schema/compress.json`（`mode` = `algorithmic` / `semantic`；目标长度；去重阈值；抽取条数 `2..3`。**75% 触发阈值不住此 schema**——触发判定归 #13（`schema/policy.json`），本插件只按调用执行，避免同一阈值两处定义漂移） |
| 机制 | 见下 |
| 边界 | 不做：直接写链（只返回计划）/ 检索（归 22）/ 去重合并与 L2→L3 固化（归 23）/ 向量计算（归 20）/ 触发判定（阈值判定归 13、准则归 33）；**不删会话消息**——压缩只写 `#3`，`#11` 的展示历史独立留存（见 #11 红线） |
| 验收 | 1) 触发后 L1 / L2 新一代可回放；2) 同输入同摘要（`algorithmic` 模式完全确定；`semantic` 模式模型调用不重放）；3) 不产生跨身份写；4) 换压缩实现不改 33 / 13；5) `extract` 产出 2–3 条、不重复；6) `compact` 后 `covered_upto` 之前轮次不再进组装 |
| 状态 | 细节设计（2026-09-19）：由单一 `summarize` 扩为三种压缩；写入 L1 / L2；由 agent 经记忆工具或 #33 管道触发 |

## 三种压缩

| 方法 | 输入 | 产出 | 写入 | 触发 |
| --- | --- | --- | --- | --- |
| `summarize` | `11` 会话切片（`covered_upto` 之后的增量）+ `3` 现有 L1 | 结构化摘要（goal / decisions / facts / open_questions / files / next_steps） | `3` L1（`sessions[C]`，更新 `covered_upto` / `expires_at`） | #33 回合尾按准则 / agent 记忆工具 |
| `compact` | 组装上下文（`11` 会话 + `3` 现有 L1） | 压缩后的上下文摘要（同 L1 结构） | `3` L1（同 `summarize`）+ 触发 `extract` | #13 判 75% → 系统消息提示 agent → agent 记忆工具 |
| `extract` | 压缩产物 | 2–3 条高价值项（结构化） | `3` L2（`workspaces[W]`，去重合并；重去重由 #23 兜底） | `compact` 内部 / #23 固化 |

- **`mode`**：`algorithmic`（纯算法抽句 / 规则，**完全确定、零 token**）/ `semantic`（eff `12 model.chat` 出摘要）。同一身份两模式，参数住 schema、可热改。
- **去重**：`summarize` / `extract` 产出与 `3` 现有条目比对（文本 + 向量余弦，**向量由 #20 提供，经 `-> 20` pin 调用**；重去重归 #23），不重复入库。
- **`extract` 的 2–3 条**：由 `compact` 一次产出，写入 **L2**；L2→L3 的固化归 #23（不在此直接写 #21）。
- **结构化产出（不解析自由文本）**：agent 被提示压缩后经记忆工具调用本插件，**工具 args 直接带结构化字段**（goal / decisions / facts / open_questions / files / next_steps），故无需从自由文本里解析摘要；`semantic` 模式也返回同结构。
- **写计划形状**：`put(合并后的 short-memory body)` + `add_gen(id:'short-memory')`；`19` 必须 `+ 3` 读-改-写（不得盲写抹掉其他会话 / 工作区）。
- **不丢图节点**：压缩只作用于**会话上下文**，不触碰 #33 的图 / 策略数据（节点仍在数据世代里）；「提示 agent 压缩」只是一条 system 消息，不删任何编排结构。

## 触发链（已定）

```
组装上下文（#13） → 估算 token ≥ 可用预算 budget × 75%（budget = context_window - max_output - 余量）
  → #13 追加 system 消息「请压缩上下文」（不删消息、不设图节点）
  → agent 调记忆工具（#27 派发到本插件 compact / extract）
  → 本插件返回写计划 → 宿主落账写 L1 / L2（covered_upto 前进）
  → 此后组装：摘要进 + covered_upto 之后的消息进 + #22 语义召回进
```

- 行为准则（何时压缩、记什么、忘什么）住 **#33 策略数据**；本插件只按调用执行，不做「该不该压」的判定。

> 原设计缺口：`#13` 边界明写「不做记忆压缩」，`#14` 管道固定 4 段没有它，`#33` 未提它 —— 本插件当时无调用者。现触发点归 #33 管道 / agent 记忆工具。
