# #11 `session`（会话数据 + 提交服务）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 11 / `session` |
| 职责 | 会话数据 + 提交服务（构造原子写计划）：**消息各自成 def（链式）**、会话元数据进 body、提交 / 新建 / **切换（select）** / 重命名 / **软删 / 恢复 / 分支** / **跨线程投递（`deliver`）** |
| 依赖 | pins 无；`+` 1；`<-` 13（投影读）、14、16、27（pins：`subagent.send` 派发到 `deliver`）、33（pins） |
| 成员 | execute, terms, schema |
| 能力类·方法 | `implements: ["session"]`，`methods: {session:["commit","new_conversation","select","rename","set_title","delete","restore","branch","deliver"]}` |
| 命令 | 无（命令面在 14 / 16） |
| schema | `schema/session.json` |
| 机制 | 见下「数据契约 / 引用解析 / 写入契约 / 新建与重命名 / 读取 / 失败 / 世界体积」 |
| 边界 | 不做搜索 / 朗读 / 调模型；分页只做按 `prev` 链的**窗口读取**（展示历史完整性所需，非搜索）；写只限自身 + `input` 清槽（经计划通道）；**不删消息、不做去重**（展示真源，见「展示与组装分离」） |
| 验收 | 1) 一轮后两条消息 def + 会话 body 新一代 + 槽 idle + 回复随观测；2) 取消的 run 不产生业务写；3) 非法槽 kind 无部分写；4) `replay` 一致；5) 换实现不改调用方；6) 世界体积线性（不随会话长度平方增长）；7) 消息链可沿 `prev` 完整还原、与提交顺序一致 |
| 状态 | 细节设计（2026-09-19）：**消息各自成 def + 链式 `head` + 宿主闭包解析**（原「整会话 body 重写」的 O(N²) 已消除）；附件走资产引用；**历史读取改窗口 + `next_before` 游标**（取消静默截断，保「全量展示」） |

> **展示与组装分离（红线）**：本插件的消息是**全量、追加、独立留存**的展示真源（对话面板按它渲染）。#13 的上下文组装（去重 / 裁剪 / 压缩边界）是**只读派生视图**，只决定发给模型的内容，**永不回写本插件、永不删消息**；#19 压缩只写 `#3`。`covered_upto` 只是 `#3` 里的组装边界标记，不代表消息被删除。

## 数据契约 `schema/session.json`

```jsonc
// 会话 body（小、可回放）：只存会话元数据 + 链头，**不列全部消息**
{ "version": 1,
  "current": "c1" | null,
  "conversations": [
    { "id": "c1", "workspace_id": "w1", "title": "…",
      // 线程字段（threads-design §一 版本提升；v1 缺键 = kind "main"，向后兼容）
      "kind": "main" | "subagent" | "group" | "workflow",
      "parent": { "def": "<父会话 id / 哈希>" } | null,        // 线程树
      "agent": { "def": "<#35 instance 条目哈希>" } | null,     // subagent：人格
      "participants": [ /* { "def": "<#35 instance 哈希>" } */ ],  // group：圆桌参与者
      "workflow": { "graph": { "def": "<#33 图哈希>" }, "node_index": 0, "iter": 0 } | null,  // workflow：图执行位置
      "inbox": { "tail": { "def": "<最新消息 def>" } | null, "count": 0, "last_seen": 0 },  // 线程收件箱（deliver 写、assemble 读后推进）
      "status": "running" | "waiting" | "blocked" | "done" | "failed" | "terminated",
      "last_activity": { "at": "…", "summary": "…" } | null,
      "pending": { "approval": 0, "question": 0 },             // 待裁决 / 待作答计数（#32 / #48 游标项）
      "head": { "def": "<最后一条消息 def 哈希>" } | null,   // 链头（引用标记）
      "count": 12, "created": "…",
      "deleted_at": "…" | null } ] }   // 软删时间戳（null = 未删）；列表读取默认滤除，可 restore

// 消息 def（各自成 def、内容寻址）：prev 指上一条，形成链
{ "id": "msg-…", "role": "user" | "assistant" | "system",
  "content": "…", "parts": [ /* 多模态 content parts，可选；**工具调用 / 结果 part 可带 `render` 渲染描述符**（#27 派发时写时快照，见 #27「工具卡渲染」） */ ],
  "attachments": [
    { "kind": "image", "name": "…", "source": { "kind": "asset", "sha256": "…", "mime": "image/png", "size": 0 } },
    { "kind": "file",  "name": "…", "source": { "kind": "asset", "sha256": "…", "mime": "text/markdown", "size": 0 },
      "text": "…" } ],   // `text` 仅可解析格式内联（#40 写入、#13 组装用）；不可解析缺省
  "meta": { "model": "…", "usage": {…}, "error": "…" },      // 可选
  "at": "…",
  "prev": { "def": "<上一条消息哈希>" } | null }
```

- 消息内容寻址 ⇒ 同内容消息天然去重（`put` 命中 `dup`）；附件字节走**资产面**（`state/assets/`，不进世界、不参与重放；缺失 → `asset_missing`，已知限制）。
- `count` 冗余记数（UI 免走链即知条数）；链完整性以 `prev` 为准。
- **线程字段随 threads 版本提升落 schema**（2026-09-19 补：原只登记在「跨插件登记」而数据契约未含，现已补齐）；`kind` 等字段 v1 实现时与 #1 H11 per-thread 键控**同批**落地（读取方依赖 #33 的 `thread_kind` 组装分派）。

## 引用解析（宿主扩展，H1 已落地）

- **标记**：body / 子 def 里的引用写成显式标记 `{"def": "<64hex>"}`。
- **解析**：宿主构造投影时，从身份 body 出发**跟随标记闭包**，把可达 def 的 body 放进 `ids.<id>.refs`（`{ <hash>: <body> }`）；**按 `prev` 链窗口返回**：默认从 `head` 逆序取最近 `W` 条（`W` 住**宿主上限**；#13 只消费组装所需窗口，不定义 `W`），并回 `next_before` 游标。超窗不丢历史——客户端带 `before` 再拉上一窗。**不再用"截断丢弃"**（原 `refs_truncated` 口径作废：静默截断会让"全量展示真源"名不副实）。
- **可达性**：`["g",["ids",<id>,"refs"]]` 是静态路径，**入口 term 可读**（服务不读投影，见 `docs/plugins.md` 通则）；`chat.history` 返回整个身份（body + refs），**客户端沿 `prev` 还原顺序**（term 不能动态索引）。
- 该扩展同时服务 `#21`（条目成 def + 链式 `tail`）、`#35`（模板 / 实例 / 通道的链式 `tail`）——三者统一用标记 + 闭包。

## 写入契约（客户端经入站面 `submit`；服务只返回计划）

```jsonc
{ "$directives": [
  { kind: "write", op: "batch", args: { ops: [
      { op: "put",     args: { body: /* 消息 def body：user 消息，prev = 当前 head 哈希（投影字面值）或 null */ } },
      { op: "put",     args: { body: /* 消息 def body：assistant 消息，prev = {"$n":0} */ } },
      { op: "put",     args: { body: /* 更新后的会话 body：head = {"$n":1}，count+2 */ } },
      { op: "add_gen", args: { id: "session", payload: { $n: 2 }, pins: {}, sig: { $n: 2 } } },
      { op: "put",     args: { body: /* 清槽：per-thread 键控——{ slots: { …其余键, "<thread_id>": { kind:"idle" } } }，只清本线程键（#1「清槽契约」） */ } },
      { op: "add_gen", args: { id: "input", payload: { $n: 4 }, pins: {}, sig: { $n: 4 } } }
  ] } },
  { kind: "extern", payload: { ok: true, reply: /* assistant 消息（给 #40 / #18） */ } }
] }
```

- 一次 `commit` = 一个 batch 原子追加 user + assistant（两条消息 def + 一次会话 body 更新）；**尾插链（append）**：新消息 `prev` 取投影里的 `head`（已存在哈希，直接写字面值），更新后的 `head` 指向最新一条（用 `{"$n":k}` 占位）。
- `add_gen` 四字段全必填、`payload` / `sig` 必须 64-hex；占位符只能指向本批内更早的 `put`。
- **清槽** = per-thread 键控清本线程键：`put({slots:{…其余键, "<thread_id>":{kind:'idle'}}})` + `add_gen(input)`（同 #1「清槽契约」；`idle` body 恒定、命中 dup 不增 def）。**无论成败都清槽**，且**不擦其他线程键**（per-thread 隔离）。
- **失败**：追加独立 `system` 消息 def（`meta.error`）；#13 默认排除 system 错误消息（可选开关）。

## 新建 / 切换与重命名

- `new_conversation`（读槽 `{kind:'session.new', workspace_id}`）：会话条目 `{id, workspace_id, title: 缺省"新对话", head:null, count:0}` + `current` 指向它 + 清槽；同类 batch。
- `select`（读槽 `{kind:'session.select', conversation}`，2026-09-19 补）：把 `current` 指向目标会话（条目已 `deleted_at` / 不存在 → `extern{ok:false}`，**无部分写**）+ 清槽；同类 batch。**这是"切回历史会话"的唯一写路径**（顶栏切线程是纯前端视图态，不落世界，见 `docs/plans/threads-design.md` §四）。
- `rename`（读槽 `{kind:'session.rename', title, conversation?}`）：改对应条目 `title` + 清槽。
- `set_title`（**服务调用路径**，args `{conversation, title}`，2026-09-19 补）：改对应条目 `title`，返回写计划（put 会话 body + `add_gen`）；**不经 `#1` 槽**——调用方是 `#49 session-title`（服务 eff 服务，非客户端命令），故用 args 而非槽。**仅当 `title` 仍为缺省值时写入**（不覆盖用户手动重命名，防竞态由调用方 + 本方法各校验一次）。
- `delete`（读槽 `{kind:'session.delete', conversation}`，2026-09-19 补）：会话条目写 `deleted_at`（**软删**：移出列表视图、**消息 def 不删不回溯**——展示真源红线）+ `current` 若指向它则回退到同工作区最近未删会话（无则 `null`）+ 清槽；**可 `restore` 撤销**（`{kind:'session.restore', conversation}` 清 `deleted_at`）。
- `branch`（读槽 `{kind:'session.branch', conversation, message}`，**后置**，形态已定）：新建会话条目（记源会话 / 源消息）+ 以源消息为父链拷贝消息 def（`prev` 重建）；清槽。
- 槽 kind 非法 → **无部分写**（只清槽 + `extern{ok:false}`）。

## 跨线程投递 `deliver`（threads-design §三）

- `deliver(to, kind, body, refs?)`（经 #27 `subagent.send` 派发）：构造 batch——put 消息 def（`kind: instruction|report|decision_request|decision`）+ 更新目标线程 `inbox.tail` + 写目标线程 `status`（`running`/`waiting`/`done`…）/`last_activity`（`at`+摘要）/`pending`（待裁决/待审批）+ 若 `to` 是新子线程则 `thread.opened`。
- **`last_seen` 推进**：目标线程 `context.assemble` 读 inbox 后，由 #11 在下一轮 `commit` / `deliver` 顺带把 `last_seen = max(seq)` 写回（已读消息下轮不再注入）。
- **事件发射**：`deliver` / `commit` 落账后，#11 服务据 body 变化**机械发 event**（发 event 非判定，是通知数据变化，见 `protocol.md` §2.5）：新会话→`thread.opened`、标题/`status`/`inbox` 变→`thread.updated`、关闭→`thread.closed`、工作流节点推进（`workflow.node_index`/`iter` 变）→`workflow.step`、群聊追加→`group.message`。事件经宿主透传、不进世界。
- `thread.status`（#27 `subagent.status`）= **只读入口 term `thread.status`**（投影读 `status` / `last_activity` / `pending`；无服务调用、不产生写）；#27 派发到该 term。
- `thread.resume` / `thread.terminate` 转交**宿主能力类 `host`**（保留身份名 `host`、不在世界；方法 `thread.resume` / `thread.terminate` / `audit`；插件以 `pins:{"host":"host"}` 声明，#27 派发到该类，非本插件）。

## 读取

- `#14 chat.history`：命令 `args` 可选 `{ conversation?, before?, limit? }`（`argsSchema` 白名单子集；缺省 `conversation` = `current`、缺省窗口 = 最近一窗）；返回 `{ body, refs, next_before }`；客户端按 `conversation` 取会话、沿 `prev` 从 `head` 逆序还原为展示顺序，滚到顶再带 `before` 拉上一窗。**返回的是全量展示历史的窗口，不经 #13 组装视图**。
- `#16 ui-sidebar`：读 body 的 `conversations`（`id` / `workspace_id` / `title` / `count`）分组渲染，无需 refs。
- `#13`：`covered_upto` 对应消息在 refs 里可查（失效则丢弃 L1，见 #3）。

## 世界体积与并发

- **体积**：每回合 = 1–2 条消息 def + 1 个**小**会话 body def（只含会话列表与 `head` 指针）⇒ 世界总量 **O(N)**；投影每轮解析闭包 O(会话长度)（设上限），不再有 O(N²)。
- **并发（2026-09-19，threads-design §二）**：run 级并发——多个 run 同时活动，锁收窄为 commit 期间；提交队列 + 乐观校验（base `worldRev`/`expect_pos` CAS）+ 冲突重试（同 `run_id`/`now`/`results` 回灌，重试占新 `seq`）。每线程写自己的会话链 ⇒ 大部分提交零冲突；`#1 input` 是 per-thread 键控（`slots[<thread_id>]`），不同键可交换、无丢失更新。本插件 `deliver` 写目标线程 inbox 也走提交队列（追加可交换）。

## 跨插件登记

- **宿主能力（H1 已落地）**：投影引用闭包解析（`{"def":hash}` → `ids.<id>.refs`）；同时服务 #21 / #35。
- **#41 workspace**：会话 schema 加 `workspace_id`（**创建即钉死、不可改**，已登记）。
- **#16 ui-sidebar（版本提升：被提升方，2026-09-19）**：新增能力方法 `session.select` / `session.delete` / `session.restore` / `session.branch` 与槽 kind `session.select` / `session.delete` / `session.restore` / `session.branch`（写 `#1`、per-thread 键控）；`select` 切 `current`（切回历史会话的唯一写路径），删除为**软删**（`deleted_at`）、消息 def 不回溯，见「新建 / 切换与重命名」。
- **#49 session-title（版本提升：被提升方，2026-09-19）**：新增能力方法 `set_title {conversation, title}`（服务调用路径，args 驱动、不走 `#1` 槽）；标题落账后本插件机械发 `thread.updated`，#16 / #46 自动跟随。
- **#13**：`chat.history` 全量展示历史独立于组装视图（§1.2 第 12 条）。
- **#3**：`covered_upto` 只作组装边界，不删本插件消息。
- **#27 tools（版本提升：被提升方）**：工具调用 / 结果消息 part 新增可选 **`render` 渲染描述符**（由 #27 派发时快照写入）——#18 按它画工具卡、回放确定、不依赖当前工具集；提出方登记见 `plugins/tools/DESIGN.md`「工具卡渲染」。
- **线程设计（版本提升：被提升方，2026-09-19）**：会话加 `kind`（`main` / `subagent` / `group` / `workflow`）/ `parent` / `agent` / `participants` / `workflow` 字段，以及 **`inbox`（线程收件箱，条目各自成 def + 链式 `tail`）+ `last_seen`** / `status` / `last_activity` / `pending`（处境）——子代理 = 子线程、协作者 = 圆桌群聊、工作流 = 步骤卡；父子消息写进目标线程 `inbox`（`kind: instruction|report|decision_request|decision`），默认只回最终 `report`；本插件新增 `deliver` 能力方法 + 落账后发 `thread.*`/`group.message`/`workflow.step` 事件；见 `docs/plans/threads-design.md` §一 / §三 / §四。
