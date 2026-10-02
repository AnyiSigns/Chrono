# chat（回合命令面 + 装配服务 + 接线）

Chrono 的对话回合入口：把「用户消息已入输入槽」翻译成一次 `loop-policy.interpret` 调用，
并把解释器返回的写计划机械合并成顶层计划值交宿主落账。
本包还负责**回合身份**（`send` 铸 `turn_id`、续跑续同一回合）与**结局三通道**（session 回合记录 ·
`chat.turn.settled` 事件 · 命令回执）。
本包是**有执行件的身份**：成员 = `execute/`（装配服务）+ `terms/`（三个命令入口）+ `schema/`（接线数据）。

## 身份与依赖

- 身份：`chat`；`implements: ["chat"]`、`methods: { chat: ["send", "history", "resume", "cancel"] }`、`start: "node execute/main.ts"`。
- `pins`：`session` → `session`、`input` → `input`、`model` → `model-protocol`、`context` → `context-window`、
  `loop-policy` → `loop-policy`。
- 入口 term 是**自能力路由**（无自引用 pin）：
  `["eff","chat","send",["g",["ids"]]]` / `["eff","chat","history",["v",0]]` /
  `["eff","chat","resume",["v",0]]` / `["eff","chat","cancel",["v",0]]`——`send` 只把投影切片（定义 / 判定数据）交给自己的服务，
  `history` / `resume` / `cancel` 收调用方随命令 / plan eval 传入的 args。
- 服务不读投影、不写链、不自取时钟（`now` 用调用帧 `env.now`）：世界数据由入口 term 读出随 args 传入。
- **运行记录改问 owner**：`input`（输入槽）与 `session`（消息链 / 会话元数据）已出世界，
  服务在 `send` / `resume` 时经反向调用 `input.read` / `session.read` 取回，覆盖投影里的同名身份条目；
  `history` 直接反向调用 `session.history`（不再读投影 `refs`、不再逐跳 hydrator 还原）。

## 命令

| 命令 | 语义 |
| --- | --- |
| `chat.send`（无参） | 服务按 `call` 帧 `env.thread` 取线程键，反向调用 `input.read` 取本线程槽 kind：`chat.message` → 跑管道；空槽 / `idle` / 非 chat kind → 幂等 no-op（`extern{ok:true,noop:true}`，不触发下游 eff）。 |
| `chat.history` | 反向调用 `session.history({conversation,before,limit,full})`，返回服务读自有存储还原的窗口（`messages` 新→旧 + `body` + 窗口内 `refs` + 窗口内 `turns`；`turns` 不带步记录）；`full:true` 为导出面显式全量（`refs` 收全量、`turns` 带步记录）。**不读投影 `refs`、不逐跳 hydrator 还原**。**不触发下游写、不写链**——声明为**只读命令**（`readonly: true`），宿主不广播其 `run.started` / `run.finished`、不落审计、不推进链头。 |
| `chat.resume` | 续同一回合，两种 args：<br>① `{cursor, thread, payload?, ids?}`——裁决 / 作答续跑：装配与 send 相同的 interpret bag，另加 `bag.resume={cursor,thread,payload}` 交 loop-policy 按游标恢复图位置，合并计划返回。<br>② `{turn_id, thread?, progress?, ids?}`——**段续跑**（本服务段尾 eval 自续）：无游标，历史窗口移到回合起点、输入取本回合用户消息，`bag.resume={continuation:true,turn_id}`，loop-policy 据会话步记录重建状态；`progress` 为上一段段尾的图内进度（含下一段序号），随 `chat.turn.started` 广播。回合已非 open（如取消竞态先落定）则不派发，回执既有状态。<br>**`ids` = 调用方随 plan eval 传入的投影切片**（内核 term 不能同时传 args 与投影）；段续跑由宿主 `inject` 并入。 |
| `chat.cancel`（args `{turn_id, thread?}`） | 协作式取消：先经 `session.turn_cancel` 落取消意图，再 `loop-policy.cancel`（停止再派发）与 `model-protocol.abort`（销毁在途 HTTP），最后 `session.turn_settle(cancelled)` 经 CAS 落终态并广播 `chat.turn.settled`。已收口回合是 no-op（回 `{cancelled:false, reason:'already_settled', outcome?}`），**不回溯成功回合**；**输入槽保留**供重试。**必须声明为并发方法**，否则会排在在途 `chat.send` 后永远到不了。 |

- **回合身份 `turn_id`**：`send` 由槽写入 run id（`input.slot_ref`）铸 `t-<slot_ref>`，随 bag → 解释器 → 步记录 →
  收口 → 事件全程携带；`resume` 从裁决 / 作答游标或段续跑 args 里续同一 `turn_id`，不重铸、不重开回合头。
  一个 `turn_id` = 一个用户意图 = 一个回合，跨 `send` + N 次 resume（长回合每段一次段续跑，逐段 `chat.turn.started`）。
- **上行事件 `chat.turn.started`**：`send` / `resume` 在派发 `loop-policy.interpret` **前**自报一次，
  载荷 `{turn_id, run, thread, conversation, source}` + 段续跑时随 args 带来的 `progress`（图内进度）——
  `run` = 顶层 run id（与宿主 `run.finished` 配对、可取消），
  `source ∈ send/resume`。用途：续跑是嵌在 `ui-approval.decide` / `question.answer` 顶层 run 内的 eval，
  没有独立宿主 run 生命周期；客户端据此在首个 `model.delta` 前建在途回合 / 显示生成态。
  空槽 / 未配置模型等回合开始前的拒绝不发；`send` 派发前尚无解释摘要，故不带图内进度（`resume` 段续跑带上一段段尾进度，UI 轮次据此实时前进）。
- **挂起事件 `chat.turn.pending`**：`loop-policy.interpret` 以 `ended:'pending'`（`approval.wait` 等审批 / 提问）
  收口时广播，载荷 `{turn_id, run, thread, conversation, pending, source}`（`pending` = 挂起种类，如 `approval`）
  + 摘要里确实存在的 `progress`（图内进度 `{iter, node_index, contract_id}`，UI 据此显示当前编排节点）。
  此时回合**未终结**（工具尚未执行），但宿主 run 会结束、`chat.turn.settled` 不会发。客户端据此保留在途回合并
  显示等待态，而不是把本段当回合定稿、恢复时再拉起一块新的在途回合（否则同一批工具卡会再次出现，观感像重复调用）。
- **终态事件 `chat.turn.settled`**：回合终态（`committed` / `refused` / `cancelled` / `interrupted`）广播给
  所有已连客户端，载荷 `{turn_id, thread, conversation, outcome, source}`（`source ∈ send/resume/cancel`）
  + 摘要里确实存在的 `progress` / `lifecycle`（解释器生命周期）/ `stop_reason`（预算收口原因，仅预算主动停的
  `committed` 携带）。**只带存在的键、不发明值**：无摘要的收口路径（传输失败 / 取消）不带这三个键。
  命令回执只到发起者（composer），
  而 ui-chat 只听事件、且审批裁决触发的 resume 发起者不是 composer，故终态必须经事件广播。
  `run.finished` 保持纯机械信号，不编码业务结局。

管道（`chat.send` 的 `chat.message` 分支）：

```
session.turn_open               // 调模型前先写回合头（含用户消息与 slot_ref；首条消息时随建会话规格一次性落盘）
model.complete (title)          // 首条用户消息时内联算标题，经 session.set_title 写回
loop-policy.interpret           // interpret bag 一次覆盖全部节点；loop-policy 自驱解释器按节点分发
  └ 逐节点写 step.intent / step.result；终态由 session.turn_settle CAS 落定
```

- 段序归 loop-policy 图数据（改图 = 数据换代热生效）；本包不再持静态管道。
- 服务按 bag 装配契约装配 interpret bag：`input` / `config` / `tier` / `session` / `graph` /
  `persona` / `skills` / `workspace_root` / `evidence` / `todo` / `guard_rules` / `sandbox_tiers` /
  `tools_bindings` / `mcp_tools` 等（缺对应身份即省略，由 loop-policy 回落种子 / 内建兜底）。
  bag 恒带 `contract_version`（取自生成契约副本 `execute/contract/` 的 `CONTRACT_VERSION`），供消费方按主版本显式拒绝过期契约。
- interpret 段返回的 `$directives` 作为顶层 `$directives` 交宿主落账（数组拼接，不构造新 JSON 对象）。
- 首条用户消息判定：投影里当前会话 `title` 仍为缺省「新对话」且 `count == 0`。
  标题生成内联在本服务：非流式单次 `model.complete`，失败 / 超时 / 空一律走 `resolveTitle` 的
  确定性兜底（首条消息前 N 字 → 缺省标题），再经 `session.set_title` 写回；不影响主回合。
- 回合开始前的拒绝（`empty_slot` / `model_not_configured` / `workspace_missing` / owner 读失败）不持久化回合，
  经命令回执交 composer 渲染引导，输入槽保留供重试；回合开始后的失败产 `refused` 结局（`attributableTo` +
  `retryable`），经 `turn_settle` 记入回合、广播 `chat.turn.settled`，并随回执返回。
- **重复回合不重跑**：`session.turn_open` 回 `already_open`（同一槽已有回合）时不再派发 `loop-policy.interpret`，
  改回 `extern{ok:true,duplicate:true,status:'in_flight'|'settled',turn_id,outcome?}` 回执——UI 据此识别「已在途」
  或已收口，不误认作新受理；输入槽保留。
- **`turn_busy`（服务端互斥兜底）**：本会话已有另一个开态回合（多窗口 / 多客户端同时发、审批挂起期间发新消息）时
  `turn_open` 回 `turn_busy`；本服务产 `refused{code:'turn_busy',retryable:true}` 随回执返回，**不落 `turn_settle`**
  （`turn_busy` 不是回合），输入槽保留供 composer 排队重试。
- 必需 owner（`session` / `config`）读失败 → `owner_unavailable`（不静默回落空切片）；
  config 读到但未配模型 → `model_not_configured`（沿用既有码，不新造）。
- **无当前会话时自动建会话**：槽带 `workspace_id` 时，服务按槽内 `conversation_id`（缺省生成）装配一个
  main 会话规格，交 `session.turn_open` 与回合头同一次 append 落盘——不再有「回合已开始但会话不存在」的中间态；
  槽缺 `workspace_id` / 工作区不存在 → `workspace_missing`，不派发 interpret。
- 系统提示词 / 工具 schema 的缺省来源 = `schema/wiring.json` 的 `system_prompt` / `tools`，
  随 interpret bag 传入；loop-policy 图内 `context.assemble` 写 bag 覆盖。

### 子代理线程（任务 + 父检查点，不继承父历史）

`chat.send` 消费的本线程槽（`kind:'chat.message'`）可声明额外字段，开一条隔离旁路线程：

| 槽字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `thread_kind` | string，可缺 | `'subagent'` 时进入子代理分支；缺省 = main（既有管道） |
| `task_prompt` | string，可缺 | 子代理任务；缺省回落槽正文。子代理分支下缺失（与正文皆空）→ `empty_slot` |
| `parent_checkpoint` | object / string，可缺 | 父检查点：结构化 summary（`{goal,constraints,decisions,findings,files,open_questions,next_steps,…}`）或裸摘要 |
| `parent_summaries` | array，可缺 | 父会话摘要回退（无结构化检查点时） |
| `parent` | object，可缺 | 父会话引用 `{def}`，写进会话条目 |
| `agent` | object，可缺 | 子代理人格 `{def}`，写进会话条目（供 agents 能力解析 `persona`） |
| `conversation_id` | string，可缺 | 显式子代理会话 id；缺省按 `c-<now>-<count>` 生成 |
| `workspace_id` | string，必需（建会话时） | 会话归属；缺失 / 未知 → `workspace_missing` |

- 子代理会话以 `kind:'subagent'` 建，**不抢占 `current`**（旁路线程）；标题取 `task_prompt`，不跑标题段。
- 任务与父检查点随 `session.turn_open` 的 `task_prompt` / `parent_checkpoint` / `parent_summaries`
  相邻字段**同一次 append 落盘**（回合头即持久真源），`thread_kind` 一并记录。
- bag 相应落 `thread_kind:'subagent'` + `task_prompt` / `parent_checkpoint` / `parent_summaries`，
  经 loop-policy `context.assemble` 的派发元数据透传给 context-window；由它按线程口径组装「任务 + 父检查点」、
  **跳过父消息历史**（子代理结果另以结构化 `checkpoint` 步记录回写）。
- 续跑（`chat.resume` 段续跑 / 裁决续跑）由 `turn_id` 经 `session.read` 定位该回合所属会话，
  从回合记录取回任务与父检查点，重启后仍可续同一子代理回合。

### 跨线程收件箱（`inbox_unread` 转发 + ack）

- `session.read` 切片的 `inbox_unread`（本会话未读投递，按 `seq` 升序）随 interpret bag 顶层
  `inbox_unread` 下传：loop-policy `context.assemble` 派发元数据透传给 context-window（所有线程口径），
  `subagent` 派发元数据另行渲染进子代理模型消息（子代理模型调用不经 context-window）。
- **确认点 = interpret 调用成功返回、且回合未以拒 / 取消收口之后**：只有解释器实际执行（模型确已消费消息）
  且回合没有失败 / 中止才经 `session.ack_inbox{conversation,seq=max未读}` 推进水位。传输 / 结构化失败
  （`interpreted.ok === false`）与解释器产出 `refused` / `cancelled` 终态都不 ack，未读保留供重试 / 续跑重投——
  **失败 / 中止回合不丢消息**；ack 幂等且单调，重复 ack 旧 seq 为 no-op。
- ack 失败不改变本回合结局、不改会话状态（session 侧只追加、以 `max` 守卫），仅水位未推进 ⇒
  下轮重投（**retryable-with-audit**，至少一次投递）。
- 子代理 `send` 指向一条已存在的旁路会话时，另读该会话切片取其未读；新建子代理会话无历史投递。

## 为什么装配下沉到服务

内核 term 只有八个原语，且**无对象 / 列表构造**、`if` 只收 Bool、`["g"]` 缺失即 `missing_path`——
入口 term 无法装配多切片 bag，也无法把各段 `$directives` 合并成顶层计划值。
故本包把**装配 / 分支 / 切片 / 合并**全部下沉到自己的 `execute` 服务；
入口 term 只传投影切片（`["g",["ids"]]`）或续跑 args（`["v",0]`）。

## 接线数据 `schema/wiring.json`

该文件既是身份自述，也是服务启动时读到的接线数据。字段：`slices` / `system_prompt` / `tools` /
`title` / `on_empty_slot` / `on_budget` / `stream` / `method_timeouts`。段序不在此（归 loop-policy 图数据）；
`title.title_default` 声明会话缺省标题（与 session 新建会话一致）；`title.prompt` / `max_chars` /
`max_tokens` / `timeout_ms` 声明内联标题生成的提示词、字数上限与调用上限。建会话规格随 `turn_open`
以缺省标题落盘，首条消息标题在回合开始后经 `session.set_title` 写回。

`method_timeouts` 为 `chat.send` / `chat.resume` 声明长安全网，须严格大于 `loop-policy.interpret`：命令端点
包住一次 `interpret`（一段内顺序跑 context.build / model.chat / tool-dispatch.dispatch 等），不得用宿主缺省 30s 封顶；
服务侧反向调用通道兜底（`PORT_CALL_TIMEOUT_MS`）落在 `loop-policy.interpret` 与命令安全网之间。
段续跑在同一个命令 run 内以 eval 连起来，故整回合不由单次安全网兜底（由预算与轮数上限约束）。
`chat.cancel` 声明 600s：它顺序反向调用
`session.turn_cancel` / `loop-policy.cancel` / `model-protocol.abort` / `session.turn_settle`，
须严格大于这些内层声明超时之和，否则外层先到期、取消链还没走完。

## 怎么起

宿主按 `start: "node execute/main.ts"` 起服务：服务自实现 stdio 帧协议，stdout 只发协议帧、
日志走 stderr，stdin EOF / 管道断开即自退出。入世后命令即可被路由到。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 测试

`npm test`（`node --test`）：包形状 / 接线 / term 入口 / 服务协议级（驱动桥接 `loop-policy.interpret`
与标题 `model.complete` 假实现，覆盖空槽 no-op、interpret bag 键完整性、`$directives` 合并、
title 触发与失败跳过、`chat.resume` 的 `args.ids` 装配与 `bag.resume` 透传、`chat.history` 链还原与切片）。
`tools/e2e-smoke.mjs`：boot CLI pack/seed chat 及其 pins 闭包（含 `loop-policy`），
核对声明 / 命令（含 `chat.resume`）/ pins 解析 / 自能力入口解析 / `.worldignore`。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/` / `terms/` / `schema/`）随源码入世。
