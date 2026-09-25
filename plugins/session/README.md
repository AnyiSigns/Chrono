# session（会话数据 + 提交服务）

世界里的会话真源与提交服务：**每条消息各自成 def、以 `prev` 串成链**，会话 body 只存元数据与链头；
服务本身**不读投影、没有写通道**——一切所需世界数据由调用方入口 term 读出后随 `args` 传入，
服务只返回**写计划**（`$directives`）与**上行事件**，宿主机械落账、透传事件。

- 能力类：`session`；方法：`commit` / `new_conversation` / `select` / `rename` / `set_title` / `delete` / `restore` / `branch` / `deliver`。
- 命令：无（命令面由后续的侧栏 / 聊天插件承接）。
- `pins`：无；`+`（投影读）：1 面——调用方入口 term 读会话 body / 输入槽 / 消息 refs 后随 args 传入。
- 状态档：`recomputable`（无不可重算状态；服务进程不留持久状态）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 时间：消息 `at`、`last_activity.at`、`deleted_at`、`created` 一律取调用帧 `env.now`（宿主固定时钟），服务不自取时钟。

## 数据契约

会话 body（小、可回放）：`{ version, current, conversations: [会话条目] }`。
会话条目含 `id` / `workspace_id` / `title` / 线程字段（`kind` / `parent` / `agent` / `participants` / `workflow`）/
`inbox: { tail, count, last_seen }` / `status` / `last_activity` / `pending` / `head` / `count` / `created` / `deleted_at`。
消息 def：`{ id, role, content, parts?, attachments?, meta?, at, prev }`。
引用一律写成显式标记 `{"def":"<64hex>"}`；宿主按引用闭包把可达 def 放进投影 `refs`。
逐字段形状见 `schema/session.json`。

## 方法 args 契约

所有方法都要求 `args` 是对象；**槽驱动方法**（`commit` / `new_conversation` / `select` / `rename` / `delete` / `restore` / `branch`）
还要求 `session` 与 `slots`。`slots` 是**轮首整份输入 body**（`{slots:{...}}`），清槽时只覆盖本线程键、其余键原样保留。

### `commit`

一次 = 原子追加 user + assistant 两条消息 def + 更新会话 body + 清本线程槽。

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `thread_id` | string，可缺 | 本线程键；缺省 `_main` |
| `session` | object，必填 | 轮首会话 body |
| `slots` | object，必填 | 轮首整份输入 body（`{slots:{...}}`） |
| `slot` | object，可缺 | 本线程槽体；缺省取 `slots.slots[thread_id]`。`kind` 必须为 `chat.message` |
| `conversation` | string，可缺 | 目标会话；缺省 `session.current` |
| `new_conversation` | object，可缺 | 无当前会话时的自动建会话规格 `{id, workspace_id, title?}`；存在则同世代原子建 main 会话并置 `current` |
| `user` | object，可缺 | `{content?, parts?, attachments?, meta?}`；`content` 缺省回落 `slot.text`，`attachments` 缺省回落 `slot.attachments` |
| `assistant` | object，必填（非失败路径） | `{content?, parts?, attachments?, meta?}`，即本轮回复 |
| `error` | string，可缺 | 失败路径：非空则追加**独立 system 消息 def**（`meta.error`），不写 user / assistant |
| `status` | string，可缺 | 可选写回会话 `status`；缺省保持原值 |
| `last_seen` | number，可缺 | 覆盖 `inbox.last_seen`；缺省推进到 `inbox.count` |

- 正常路径计划 ops（下标即占位符编号）：`put(user, prev=当前 head 字面哈希或 null)` → `put(assistant, prev={"def":{"$n":0}})` → `put(新会话 body, head={"def":{"$n":1}}, count+2)` → `add_gen(session, {"$n":2})` → `put(清槽整份 slots)` → `add_gen(input, {"$n":4})`。
- 失败路径：`put(system, meta.error)` → `put(新会话 body, head={"def":{"$n":0}}, count+1)` → `add_gen(session, {"$n":1})` → 清槽两条。
- `extern.payload`：正常 `{ok:true, reply:<assistant 消息 body>, conversation, count}`；失败 `{ok:false, error}`。
- 非法槽 kind / 目标会话不存在：**无部分写**——只 `put(清槽)` + `add_gen(input)`，`extern{ok:false, reason}`。
- 无 `current` / 目标会话不存在：带 `new_conversation` 则同世代原子建 main 会话（`upsertConversation` + `current` 指向；事件补 `thread.opened`、`changed` 含 `current`）再提交；否则 `no_conversation`。

### `new_conversation`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `thread_id` | string，可缺 | 缺省 `_main` |
| `session` / `slots` | object，必填 | 同上 |
| `slot` | object，可缺 | `kind` 必须为 `session.new` |
| `workspace_id` | string，可缺 | 缺省回落 `slot.workspace_id` |
| `title` | string，可缺 | 缺省「新对话」 |
| `conversation_id` | string，可缺 | 新会话 id；缺省按帧时钟与现有条数生成 |

新建条目（`kind:"main"`、`status:"waiting"`、空链）+ `current` 指向它 + 清槽；`extern{ok:true, conversation}`。
事件：`thread.opened`（新会话）、`thread.updated`（`current` 变）。

### `select` / `rename` / `delete` / `restore`

均为槽驱动；`slot.kind` 依次必须是 `session.select` / `session.rename` / `session.delete` / `session.restore`。

| 方法 | 额外字段 | 语义 |
| --- | --- | --- |
| `select` | `conversation?`（回落 `slot.conversation`、再回落 `session.current`） | 把 `current` 指向目标会话；目标不存在 / 已软删 → 只清槽 + `extern{ok:false, reason}` |
| `rename` | `conversation?`、`title?`（回落 `slot.title`） | 改对应条目 `title`；缺 title / 目标不存在 → 只清槽失败值 |
| `delete` | `conversation?` | 软删（写 `deleted_at`），消息 def 不删不回溯；`current` 若指向它则回退同工作区最近未删会话（无则 `null`） |
| `restore` | `conversation?` | 清 `deleted_at` |

成功 `extern{ok:true, conversation}`（`delete` 另带 `current`）。事件：`select`→`thread.updated`（`current`）；`rename`→`thread.updated`（`title`）；`delete`→`thread.closed`（+ `current` 回退时 `thread.updated`）；`restore`→`thread.updated`。

### `set_title`

服务调用路径（args 驱动、**不经输入槽、不清槽**），供自动标题一类调用方使用。

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `session` | object，必填 | 轮首会话 body |
| `conversation` | string，必填 | 目标会话 id |
| `title` | string，必填 | 新标题 |

无条件写入（不做「是否首条」判定）；计划 ops：`put(新会话 body)` + `add_gen(session, {"$n":0})`。
目标不存在 → `extern{ok:false, reason:"not_found"}`（无写）；缺 `conversation` / `title` → 结构化 `bad_args`。
事件：`thread.updated`（`title`）。

### `branch`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `thread_id` / `session` / `slots` / `slot` | 同上 | `slot.kind` 必须为 `session.branch` |
| `conversation` | string，可缺 | 源会话；缺省 `slot.conversation`、再回落 `session.current` |
| `message` | string，可缺 | 源消息（消息 `id` 或 def 哈希）；缺省回落 `slot.message` |
| `refs` | object，可缺 | 源链投影 refs（`{<hash>: <消息 body>}`），沿 `prev` 回溯重建链所需 |
| `conversation_id` | string，可缺 | 新会话 id；缺省生成 |

新建会话条目（`parent` 记源会话、`source_message` 记源消息 id / def 哈希）+ 以源消息为父链**拷贝消息 def 并重建 `prev`**（链首 `prev:null`，其后用批内占位符），
`current` 指向新会话 + 清槽。`extern{ok:true, conversation, count}`。
refs 缺 / 目标消息不在链上 → 只清槽失败值。事件：`thread.opened`、`thread.updated`（`current`）。

### `deliver`（跨线程投递）

服务调用路径（args 驱动、不清槽），供线程控制面把父 / 子消息写进目标线程 `inbox`。

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `session` | object，必填 | 会话 body |
| `to` | string，必填 | 目标线程 id；不存在则新建子线程 |
| `kind` | string，必填 | `instruction` / `report` / `decision_request` / `decision` |
| `body` | 任意 JSON，必填（键须存在） | 消息体 |
| `from` | string，可缺 | 发送者；缺省 `user` |
| `refs` | array，可缺 | 消息引用数组，原样写进 inbox 条目 |
| `status` | string，可缺 | 写目标线程 `status` |
| `last_activity` | object，可缺 | `{at, summary}`；缺省 `{at: env.now, summary: body 摘要}` |
| `pending` | object，可缺 | `{approval, question}`；缺省保持原值 |
| `workflow` | object，可缺 | `{graph, node_index, iter}`；缺省保持原值 |
| `last_seen` | number，可缺 | 只增不减地推进 `inbox.last_seen` |
| `thread_kind` / `title` / `workspace_id` / `parent` / `agent` / `participants` | 可缺 | 新建子线程时用 |

计划 ops：`put(inbox 消息 def, prev=轮首 inbox.tail 哈希或 null)` → `put(会话 body, inbox.tail={"def":{"$n":0}}, count+1, status/last_activity/pending/workflow)` → `add_gen(session, {"$n":1})`。
`extern{ok:true, to, seq, status, kind}`（`seq = inbox.count + 1`）。
事件按数据变化机械发：`inbox` 变→`thread.updated`（`status` 变并入同一事件的 `changed`）；新线程→`thread.opened`；
`status` 进入终态→`thread.closed`；`workflow.node_index` / `iter` 变→`workflow.step`；目标 `kind:"group"`→`group.message`。

## 计划形状

```jsonc
{ "$directives": [
  { "kind": "write",
    "request": { "op": "batch", "args": { "ops": [
      { "op": "put",     "args": { "body": /* … */ } },
      { "op": "add_gen", "args": { "id": "session", "payload": { "$n": 2 }, "sig": { "$n": 2 }, "pins": {} } }
    ] } } },
  { "kind": "extern", "payload": { "ok": true } }
] }
```

- 占位符 `{"$n":k}` 只能指向**同批更早的 `put`**；`add_gen` 四字段（`id` / `payload` / `pins` / `sig`）全必填。
- 服务只返回计划，不落账：`id` / `by` / `ref` / `target.expect_pos` 由宿主机械填。

## 事件清单

事件是**乐观通知**（随计划一起发；计划被取消 / 拒绝时可能有罕见假事件，UI 以重新拉取定稿）。
载荷基座：`run` 取帧 `env.run`；**数据变更类事件（下表全部）的 `thread` = 目标线程**
（被改 / 被打开的会话 id，不是发起 run 的 `env.thread`），`conversation` 保留同值——UI 按当前
视图线程过滤时，通知能落到被改的线程上。`group.message` 另带消息 `id`（新消息 def 的 id）。

| topic | 触发 | 附加载荷 |
| --- | --- | --- |
| `thread.opened` | 新建会话 / 新建子线程 / 分支 | `kind`（分支另带 `source` / `message`） |
| `thread.updated` | 标题 / `status` / `inbox` / `current` / `deleted_at` 变 | `changed: [...]` |
| `thread.closed` | 软删；或 `deliver` 把 `status` 置为 `done` / `failed` / `terminated` | `status` |
| `workflow.step` | `workflow.node_index` / `iter` 变 | `node_index` / `iter` |
| `group.message` | `kind:"group"` 线程追加消息 | `id`（消息 id）、`seq`、`from` |

## 边界

- **展示与组装分离**：本插件的消息是全量、追加、独立留存的展示真源；上下文组装是只读派生视图，永不回写本插件、永不删消息。
- 不做搜索 / 朗读 / 调模型；读取（按 `prev` 链的窗口）由调用方在投影 `refs` 上切片完成。
- 写只限本身份 + 输入槽清槽（经计划通道）；不删消息、不做去重。
- 服务**不 import 宿主与内核**，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 计划落账 E2E（pack → seed → start → commit → run → stop → verify/replay）
```
