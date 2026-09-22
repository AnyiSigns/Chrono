# #14 `chat`（命令面 + 回合管道服务 + 接线）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 14 / `chat` |
| 职责 | 命令面（`chat.send` / `chat.history` / `chat.resume`）+ 回合管道**装配服务**（`execute`）+ 接线配置；**execute + term** |
| 依赖 | `+` 1（入口 term 读输入槽判分支）、**2、3、11（装配 bag）+ 33 六类条目 / 35 / 36 / 41 / 43 / 47 + 26 规则 body / 25 档位映射 body / 27 绑定表 / 37 MCP 清单（interpret bag，§1.14 总表）**；`->` 11、12、13、**33（`loop-policy`：入口 term eff `loop-policy.interpret`）**、**49（pins：`session-title`，首条消息标题段）**；`<-` 16、18、39、48（按名 / 续跑） |
| 成员 | execute, terms, schema |
| 能力类·方法 | `chat`：`send` / `history` / `resume`（自能力路由：入口 term `eff` 进自己的服务，H21，无自 pin） |
| 命令 | `chat.send`（跑管道；无参）、`chat.history`（读 11 投影；v1 返回 `body` + 全量 `refs`，客户端沿 `prev` 还原与切窗）、`chat.resume`（跨 run 续跑；args `{cursor, thread, payload?, ids?}`，H18） |
| schema | `schema/wiring.json`（切片清单 + 系统提示 / 工具 schema + title 段 + 空槽 / 预算口径；服务启动读自身包内 schema，可热改 = 数据换代） |
| 机制 | 见下「管道 / 命令 / 接线 / 失败」 |
| 边界 | 不做：写世界（归 11）/ 分支策略 / 自建循环 / 工具与审批编排（归 33）/ 调模型实现（归 12）/ 组装实现（归 13）/ **term 不拼 JSON**（ctx 与 args 合流只发生在服务里）/ **计划上提（机械合并）**：服务把 interpret 段与 title 段返回 value 里的 `$directives` 按段序合并为顶层 eval 值——机械数组合并、不构造新 JSON 对象；title 段失败 / 无计划一律跳过 |
| 验收 | 1) 三条命令可用：`chat.send` 无参、`chat.resume` 支持 `{cursor, thread, payload?, ids?}`；**`chat.history` v1 契约 = 服务返回 `body` + 全量 `refs`（沿 `prev` 还原展示序），由客户端（#18）自行切窗**——入口 term 只传 `["g",["ids"]]` 投影，命令 args `{conversation,before,limit}` 到不了服务（服务侧 `parseHistoryQuery` 切片能力保留为后置，见命令表）；2) 换下游实现不改 14；3) 管道换代热生效；4) 空槽 / 非 chat 槽幂等（不产生业务写）；5) 读命令不触发**下游业务** eff（自身服务入口的 `eff` 除外）、不写链；6) `chat.history` 返回展示历史（`body`+`refs`）、不经组装视图、客户端可沿 `prev` 翻页取全量；7) **首条用户消息后触发 `session-title.generate`，非首条不触发，且标题段失败不影响主回合**；8) **`chat.send` 装配的 interpret bag 覆盖 §1.14 全键**，`chat.resume` 装配同 bag + `bag.resume` |
| 状态 | 升代落地：静态管道（`context.build → model.chat → session.commit`）替换为 `port.call loop-policy.interpret`；`pins` 增 `loop-policy`、补 `chat.resume` |

## 为什么是 execute + term（A 案）

内核 term 只有八个原语（`c` / `g` / `v` / `cmp` / `if` / `fold` / `eff` / `call`），且：

- **无对象 / 列表构造**：无法装配「多切片 bag」（`{config, input, memories, session, graph, …}`）；
- **`if` 只收 Bool**：`cmp` 产 Int，动态分支不可表达；
- **`["g"]` 缺失即 `missing_path`**：无法做空槽守卫；
- **无法合并 `$directives`**：不能把各段返回的计划拼成顶层计划值。

因此**装配 / 分支 / 切片 / 合并全部下沉到本插件自己的 `execute` 服务**：

- `chat.send` / `chat.history` 入口 term 只做 `["eff","chat","<method>",["g",["ids"]]]`——把投影切片交给自己的服务（H21 自能力路由，无自引用 pin）；
- `chat.resume` 入口 term 做 `["eff","chat","resume",["v",0]]`——续跑 args 由调用方（#39 / #48 服务）随 plan eval 提供（内核 term 不能同时传 args 与投影，投影切片随 `args.ids` 传入）；
- 服务装配 interpret bag 后反向 `port.call loop-policy.interpret`，机械合并返回计划。

## 管道（服务内装配，段序归 #33 图数据）

```
chat.send（读 env.thread 取线程键，读槽 kind）
  -> port.call 33 loop-policy.interpret   （interpret bag 一次覆盖全部节点；#33 自驱解释器按节点分发）
  -> port.call 49 session-title.generate  （**仅首条用户消息**；旁路，on_fail=ignore）
```

- **段序不再住本插件**：回合管道 = #33 图数据（`contracts` / `nodes` / `graph` / `thresholds`），改图 = 数据换代热生效。
- **bag 装配在服务**：入口 term 读 `ctx.ids` 传整份投影，服务按 §1.14「bag 装配总表」装配 interpret bag（ctx 与 args 的合流只发生在服务里）。
- **计划合并**：interpret 段与 title 段返回 value 里的 `$directives` 按段序数组拼接为顶层 `$directives`；结构化失败以 `extern` 收口。
- **召回先于组装**：`#33` 图内 `recall` 节点（#22 retrieval）在 `context.assemble` 之前插；本插件不再管召回。

## 命令

| 命令 | 语义 | 备注 |
| --- | --- | --- |
| `chat.send` | 无参；服务读 `env.thread` 取线程键，读 `#1` 槽 kind：`chat.message` → 跑管道；**空槽 / `idle` / 非 chat kind → 幂等 no-op + `extern{ok:true,noop:true}`** | 写类载荷已先入槽（§1.2 第 2 条） |
| `chat.history` | **v1 契约**：入口 term 传 `["g",["ids"]]`（仅投影），服务在 `#11` 的 `body` + 全量 `refs` 上沿 `prev` 还原展示序并整体返回（`messages` = 全链 + `body` + `refs`，`next_before` 恒 `null`）；**客户端（#18）在 `refs` 上自行沿 `prev` 还原与切窗**。命令 args `{ conversation?, before?, limit? }` 因内核 term 不能同时传 args 与投影而**到不了服务**；服务侧 `parseHistoryQuery` / `sliceChain` 切片能力保留，待后置入口形态启用 | **展示历史窗口**；不经 #13 组装视图；同时带 `body` / `refs` 供 #16 会话列表与 #18 还原 |
| `chat.resume` | args `{cursor, thread, payload?, ids?}`；服务装配**与 send 相同的 interpret bag** + `bag.resume={cursor,thread,payload}`，`port.call loop-policy.interpret` 恢复执行，合并计划返回 | **`ids` = 调用方随 plan eval args 传入的投影切片**（内核 term 不能同时传 args 与投影，见 #16 `reveal` / #17 `search` 先例）；由 #39 审批裁决 / #48 提问作答的入口 term 产续跑计划（H18）触发 |

- `chat.history` **不触发下游业务 eff**、不写链、不推进 head（入口 term 对自身服务的 `eff` 是自能力路由）。
- `chat.send` 的槽清理由 **#33 图内 `turn.commit`（#11 `commit`）的计划**完成。

## interpret bag（服务装配，§1.14 总表）

| bag 键 | 来源 | 下游 |
| --- | --- | --- |
| `input` / `input_body` | `#1` 槽（本线程）+ 整份 slots body（供 `turn.commit` 清槽） | #33 → #13 / #11 |
| `config` | `#2` 连接实例 + 所选模型 + 档案 | #33 → #12 / #13 |
| `tier` | `#2 permission` 档 | #33 → #26 / #25 / #27 |
| `memories` | `#3` L1（本会话）/ L2（工作区），按 slices 开关 | #33 → #13 |
| `session` | `#11` body + 当前链头 + 全量 refs | #33 → #13 / #11 |
| `graph` | `#33` 六类条目 body + refs 闭包 | #33 解释器 |
| `persona` | `#35` 当前会话 `agent` 实例 → `system_prompt` 文本 | #33 → #13 |
| `skills` | `#36` 技能候选 | #33 → #13 |
| `workspace_root` / `workspace_id` | `#41` workspaces（经 `#11` 会话 `workspace_id` 解析 path） | #33 → #27 / #26 / scope 过滤 |
| `evidence` / `evolution` | `#43` 台账四类链 body + refs 闭包 | #33 提案扫描 |
| `todo` | `#47` 当前会话条目沿链还原为 `{items:[…]}` | #33 `todo_incomplete` 门禁 |
| `guard_rules` | `#26` 规则 body | #33 → #26 |
| `sandbox_tiers` | `#25` 档位映射 body | #33 → #27 / 提供者 |
| `tools_bindings` / `mcp_tools` | `#27` 绑定表 body / `#37` 外部工具清单 | #33 → #27 |
| `thread` / `thread_kind` / `style` / `system_prompt` / `tools` | 线程键 / 会话 kind / `#2 ui.style` / 本包缺省系统提示 / 工具 schema | #33 → #13 |

- `#43` 身份名为 `evolution`：真实消费者（#33 `proposals.ts`）读 `bag.evolution`，文档口径名 `bag.evidence` 同时落键，二者同源。
- 缺对应身份时该键省略，由 #33 回落包内种子图 / 内建兜底。

## 接线 `schema/wiring.json`

```jsonc
{ "slices": { "prompt": true, "l2": true, "l1": true, "skill": true, "recall": false, "history": true, "style": true },
  "system_prompt": "…（#33 无图级提示词时的缺省系统提示词本体）…",
  "tools": [],                                       // 缺省工具 schema；#33 到位后由目录覆盖
  "title": { "segment": "session-title.generate", "when": "first_message", "on_fail": "ignore", "title_default": "新对话", "args": ["conversation", "first_message", "vendor", "model", "params", "config", "session", "title_default"] },
  "on_empty_slot": "noop",                 // noop | error
  "on_budget": "fail",                     // 预算失败消费口径
  "stream": { "topic": "model.delta" } }
```

- `slices` = 本插件装配记忆 / 技能 / 风格 / 召回切片的开关；改此表 = 换代热生效。
- **段序不再住 wiring**（归 #33 图数据）；`system_prompt` / `tools` 只作 #33 缺图级数据时的缺省。
- `on_empty_slot` 默认 `noop`（空槽幂等，验收 4）。
- **标题段（`title`，旁路段）**：仅当本回合是会话首条用户消息（`#11` 投影：`title` 仍为缺省「新对话」且 `count == 0`）时触发；args = `{ conversation, first_message, vendor, model, params, config, session, title_default }`（服务读 `#1` / `#2` / `#11` 装配）。**`on_fail = "ignore"`**：标题段传输失败 / 无计划 / 回错误值一律跳过，不使主回合 `refused`。

## 失败

- interpret 传输失败 → 服务以 `extern{ok:false,error:{code:'loop_unavailable',…}}` 收口。
- interpret 回结构化失败值（`{ok:false,…}`）→ 原样 `extern` 收口。
- 图内节点失败 / 拒绝 → 由 #33 解释器短路到 sink 收口，随 `session.commit` 落账。
- 连接配置缺 vendor / model / base_url → `model_not_configured`，不派发 interpret。
- 取消（`cancel{run}`）→ 丢弃未落账部分；已落账不回溯。

## 跨插件登记

- **#33 `loop-policy`**：入口 term eff `loop-policy.interpret`（服务自驱图解释器）；**title 旁路段保留归 #14**；**interpret bag 装配义务归本插件**（§1.14）；命令面仍归 14；`pins` 增 `loop-policy`。
- **#39 ui-approval / #48 question**：裁决 / 作答命令的入口 term 产 `{kind:'eval', command:'chat.resume', args:{cursor, thread, payload, ids}}` 续跑计划（H18）；`ids` 由调用方读出随 args 传入（term 不能同时传 args 与投影）。
- **#49 session-title（被提升方）**：管道新增 `title` 段与 pin `session-title`；仅首条用户消息触发、`on_fail=ignore`；title 段 args 含 `config` 与 `session`。
- **#16 ui-sidebar / #18 ui-chat**：`chat.history` 返回窗口同时带 `body` / `refs`；`session.new` 命令 → eff `session.new_conversation`（映射登记）。

## 实现状态与前置

- **成员落地**：`plugin.json`（`implements:["chat"]`、`methods:{chat:[send,history,resume]}`、`start:"node execute/main.ts"`）/ `schema/wiring.json`（接线数据）/ `execute/`（帧协议 + interpret bag 装配 + 历史切片 + 计划合并）/ `terms/`（三个自能力入口）/ `README.md` / `.worldignore`。
- **入口 term**：`["eff","chat","send",["g",["ids"]]]` / `["eff","chat","history",["g",["ids"]]]` / `["eff","chat","resume",["v",0]]`。
- **服务边界**：无写通道、不取时间 / 随机（`now` 用 `env.now`）、同输入同输出；跨插件只走 `port.call`；服务不读投影。
- **v1 偏差（登记）**：`bag.config.quirks` 从 `#2 config` 的 provider / 模型档案读；按 `<vendor>` 动态读 `vendor-*` body 的完整 quirks 装配待编排侧补齐。
