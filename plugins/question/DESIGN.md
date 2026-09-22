# #48 `question`（向用户提问）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 48 / `question` |
| 职责 | agent **向用户提问并等待回答**：工具 `question`（入队 + 产挂起游标）+ 用户作答落账后**续跑**把答案回灌给 agent；队列进世界 |
| 依赖 | `<-` 27（pins：工具类 `question` 派发）；`<-` 33（按游标触发新 run）；`+` 1（`question.answer` 槽：入口 term 读 `ctx.ids.input.body.slots` 后经 args 传入；服务**不读投影**，D8）、11（当前会话 id 由调用方入口 term 读 `ctx.ids.session.body.current` 后经 args 传入，D8） |
| 成员 | **terms**（命令 `question.answer`）、execute、schema |
| 能力类·方法 | `implements: ["question"]`，`methods: {"question":["describe","invoke","list"]}`（**类名 = 身份名**）；`describe` 回工具名 `question` |
| 命令 | `question.answer`（读槽 `{kind:'question.answer', id, answers}`；产**写计划**：记答案 + 清队列项）；命令按名调用、不需 pins |
| schema | `schema/question.json`（问题数上限 / 选项上限 / 是否允许自定义输入 / **`expires_at` 时长（可配）** / **`question.sweep` 周期（宿主 periodic，D6）**；**队列 body 形状见下「队列数据契约」**；可热改）（2026-09-20 修订） |
| 机制 | 见下「队列与续跑 / 工具 / 渲染」 |
| 边界 | 不做：审批判定（allow / deny 门禁归 #26 / #32）/ 写其他身份 / 阻塞等待（不用 `eff` 阻塞，见机制） |
| 验收 | 1) 提问后 run **正常结束**（不是 `waiting`）；2) 作答后按**游标**触发新 run、答案出现在 agent 上下文；3) 多问题 / 多选 / 自定义输入都可用；4) 队列跨 run 持久、可回放；5) 卡在消息流内渲染、已答折叠成记录；6) 换渲染实现不改 #27 |
| 状态 | 新增（2026-09-19）。**版本提升：提出方** —— 要求 #1 `input` 加槽 kind `question.answer` 与字段 `answers`（被提升方登记见 `plugins/input/DESIGN.md`；双方各记一条，§1.6）；**`question.pending` 事件 emitter = 本插件服务**（供 #38 通知） |

## 队列与续跑（复用 #32 的跨 run 机制）

- **提问不是阻塞**：受调用超时约束，`eff` 不能等人。故走与 #32 审批同源的形状——
  ① 工具 `question` 产**写计划**：队列项进世界（`{id, run, session, thread, questions, answers:null, resume:{command:'chat.resume', args}, at, expires_at}`）；**不读 #1 槽、也不清槽**（工具不消费 #1；清槽会误擦本线程输入槽，见下「清槽只归 `question.answer`」）；
  ② 本 run **正常结束**（不是 `waiting`）；**`question.pending` 在入队计划产出时即发**（乐观通知；#38 通知与 #18 卡片以命令重拉定稿；载荷带 `run` / `thread` / 队列项 id，经宿主透传 → #38 始终通知，避免用户离开时静默挂起）（2026-09-20 修订）；
  ③ 用户在卡上作答 → `question.answer` 入口 term 产 `[eval(command:'chat.resume', args:{cursor, thread, payload:{answers}, ids}), write(记答案（标 `answered`）+ 清槽)]` 续跑计划（H18；args 形状与 #14 `chat.resume` 契约一致）。**`ids` = 入口 term 传入的投影切片，原样带上**——内核 term 不能同时传 args 与投影，续跑 eval 无法再取 `["g",["ids"]]`，故由调用方携带供 #14 服务装配 interpret bag（先例见 #16 `reveal` / #17 `search`）（2026-09-20 修订）；
  ④ 宿主据队列项里的 **`resume:{command:'chat.resume', args}`** 触发**新 run**，把答案回灌给 agent（作为 `question` 工具的结果）（2026-09-20 修订）。
- **与 #32 的区别（写死）**：审批 = **allow / deny 门禁**（改的是"能不能继续"）；question = **开放作答**（补的是"缺的信息"）。机制同源、语义不同，故分身份。
- **过期（2026-09-20 修订）**：item 带 `expires_at`（schema 可配）；**`question.sweep` 周期清理（宿主 periodic，周期住 schema）**——过期项标 `expired`、不再等答案（清理只动索引，def 仍在链上）。

### 队列数据契约 `schema/question.json`

```jsonc
// 世界 body（可回放；链式 tail + count，同 #32 approval）
{ "version": 1,
  "tail": { "def": "<最新 item def 哈希>" } | null,
  "count": 0 }

// item def（各自成 def、prev 成链；投影引用闭包进 ids.question.refs）
{ "id": "q-<run>-<seq>",                 // 确定性 id（run + 队列序），非随机
  "run": "…", "session": "…", "thread": "…",   // thread = 入队时的线程 id（来自 bag）（2026-09-20 修订）
  "questions": [ { id, header, question, options[], multiple, custom } ],
  "answers": null | [ … ],               // 作答后回填
  "resume": { "command": "chat.resume", "args": { "iter": 2, "cursor": "…", "slots": { … } } } | null,   // 续跑依据（H5 v1 / H18，与 #32 同源；args 字段对齐 #33 eval args）（2026-09-20 修订）
  "at": "…",
  "expires_at": "…" | null,              // item 带过期时间（schema 可配）；`question.sweep` 周期清理（宿主 periodic，周期住 schema）——过期项标 `expired`、不再等答案（2026-09-20 修订）
  "prev": { "def": "<上一 item 哈希>" } | null }
```

- **`question.answer` 如何定位 item**：#1 槽 `{kind:'question.answer', id, answers}` 的 `id` = item 的确定性 id（`q-<run>-<seq>`）；入口 term 投影读 `ids.question.body`（沿 `tail` 链）解析到该 id 的 item def，把 **item 体经 args 传入**后产 **`[eval(command:'chat.resume', args:{cursor, thread, payload:{answers}, ids}), write(记答案（标 `answered`）+ 清槽)]`**（H18，2026-09-20 修订；args 形状与 #14 契约一致：cursor/thread 透传自 item、answers 进 payload、`ids` = 入口 term 收到的投影切片原样带上）。**清项 = 标 `answered`（不删 def——答案要供续跑读取）**；answers 经 `chat.resume` → interpret → 作为 question 工具结果回灌 `tool.dispatch`。入口 term 投影读为 terms 成员、合法（term 直接产 directive，无需服务方法；服务**不读投影**，D8）。id 找不到（已被归档 / 已答）→ 结构化拒、不部分写。
- **清槽只归 `question.answer`**：工具 `question` 的 `invoke` 不消费 #1 槽，故**不清槽**（否则擦掉本线程输入槽、本回合输入丢失）；只有 `question.answer` 命令计划在同批清 `question.answer` 槽（per-thread 键控，见 #1「清槽契约」）。

## 工具

```jsonc
question(bag.args = { questions: [
  { "id": "q1", "header": "顶栏位置", "question": "…",
    "options": [ { "label": "…", "description": "…" } ],   // 可空 = 纯开放作答
    "multiple": false, "custom": true } ] })
  -> { "answers": { "q1": ["…"] } }        // 作答后由续跑回灌
```

- `describe.render` 用 `detail.kind:"question"`（见下）；`list` 读队列（UI / 调试用）。

## 渲染（消息流内交互卡，由 #18 画）

- **形态**：`{ form:"card", label:"question", summary:"{header}", tone:"plain",
  detail:{ kind:"question", interactive:true, id:"q-<run>-<seq>", questions:[…], expired:false, answers:null } }`。
  - **载荷字段（写死）**：`id` = 队列项 id（`q-<run>-<seq>`，供 #18 提交 `question.answer` 定位 item）；`expired` = 是否已由 `question.sweep` 标过期；`answers` = 作答快照（未答 `null`，已答为 `[{question_id, selected, custom?}]`）——三者随消息 part 快照进 #11，使 #18 能提交 / 折叠 / 呈现 expired，且回放确定。
- **交互**：#18 的 `question` 交互渲染器 —— 单选 / 多选（`multiple`）/ 自定义输入（`custom`）/ 提交；提交经**入站面**写槽 + 调 `question.answer`（**按名调用、不需 pins**）。
- **已答**：折叠成一条记录（问 + 答），随消息历史留存、可回放。
- **已超时（`expired`，2026-09-20 双侧登记）**：`question.sweep` 标 `expired` 的项，#18 卡片呈**整卡弱化（`--c-text-3`）+ 「已超时」标签（warning 前景字），选项与提交禁用、不可再答**（与本插件「过期不再等答案」一致）；卡不自动消失、随历史留存。**与 #39 审批的 `expired`「仍可裁决」刻意相反**——审批不自动裁决是安全考量，question 过期是 sweep 已定终局；实现时勿照抄审批口径。呈现细节见 `plugins/ui-chat/DESIGN.md`「question 交互渲染器」。
- **不抢 slot**：卡在 `main` 槽的消息流里（不进 dock / overlay），历史里能看到"问过什么 / 答了什么"。

## 跨插件登记

- **#1 input（版本提升：提出方，见上「状态」行）**：槽 kind 新增 `question.answer`、字段新增 `answers`。
- **#27 tools**：按工具类 `question` 派发；工具名 `question`。
- **#33 loop-policy**：提问产 resume 游标、作答后按游标触发新 run（与 #32 同源机制）。
- **#14 chat（2026-09-20 新增）**：**`chat.resume` 续跑（双方登记）**——`question.answer` 入口 term 产 `eval(command:'chat.resume')`，宿主起新 run 后由 #14 入口 term eff `interpret`（bag 带 `bag.resume`）。
- **#18 ui-chat**：新增 `detail.kind:"question"` 交互渲染器（消息流内）。
- **#38 ui-notify（2026-09-19 补）**：订阅本插件发的 `question.pending` 事件（始终通知，开关 `ui.notify.question_pending`）；通知只提示、不挂作答按钮。
- **事件 emitter = #48 服务**：`question.pending` 由本插件服务在队列项落账后发（`protocol.md` §2.5 上行事件，`impl="question"`）；宿主 `event` 透传（H10「事件 emitter 服务化」）。ui-design §15 / draft H10 的 emitter 登记归其所有者补。
- **#32 approval**：机制同源、语义不同；两者共用"队列进世界 + 跨 run 续跑"的宿主能力。
- **宿主能力**：无新增（复用 #32 的 H5 plan 通道续跑）。
