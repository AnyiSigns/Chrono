# question（向用户提问并等待回答）

agent 向用户提问并等待作答：工具 `question` 把问题队列项写**服务自有持久存储**（④ `CHRONO_PLUGIN_DATA`）后
**本回合正常结束**（不阻塞、不用 `eff` 等待），用户作答后续跑，把答案回灌为本次工具调用的结果。
队列与 resume 游标是**运行记录**，**不进世界**——不产 `write` directive、不占 `seq`、不改 `worldRev`。

- 能力类：`question`（`describe` / `invoke` / `list` / `sweep`）。
- `pins`：`{"input":"input"}`——作答槽属 `input` 服务，服务经**反向调用** `input.read` 取槽、`input.clear` 清槽。
- 命令：`question.answer`（入口 `terms/question.answer.json`，`["eff","question","invoke",["c",null]]`——不再传投影切片）。
- 事件：入队时上行 `question.pending`（载荷带 `run` / `thread` / 队列项 id），供通知面消费。
- 状态档：`durable`（④ 不可重算）；`exclusive: ["data"]`（单写句柄）。启动：`node execute/main.ts`。
- 运行时零 npm 依赖；服务不读投影、无写链通道、不取时间 / 随机（`at` / `now` 由 bag / env 传入），同输入同输出。

## 存储引擎与落点

- ④ `CHRONO_PLUGIN_DATA/question.jsonl`：单文件追加日志，每条逻辑写一次 append + fsync（换行收尾）；
  启动重放即得全量队列。记录 `{t:'turn'|'write', run, ...}`：`write.ops` 为 `item`（upsert）/`count`（累计入队数）。
- ③ `CHRONO_PLUGIN_STATE/index.json`：派生物（记录水位 / 计数 / 项数），删掉可由 ④ 重放重建，**不承载真源**。
- 回合标记 `{t:'turn', run, state:'open'|'closed'}`：存在 `open` 且无 `closed` 即中断残留，`pendingTurns()` 可辨识。
- **为何自写而非委托 `storage-*`**：作答续跑要求入队当场落账游标、作答当场读回并改写，自写零协议往返、零审计。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

队列项（住自有存储）：

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `id` / `op_key` | 运行记录（出世界） | 队列项标识与幂等键；回滚不该带；判定不从世界读 |
| `run` / `session` / `thread` | 运行记录 | 回合 / 会话 / 线程元数据 |
| `questions` | 运行记录 | 问题载荷（展示 + 作答回填），无判定读 |
| `answers` | 运行记录 | 作答回填；经 resume 游标 payload 回灌 loop-policy，**不从世界读** |
| `expired` | 运行记录 | 过期标记；`sweep` 只标状态、不自动裁决 |
| `resume`（含 `cursor`） | 运行记录（**owner 持久化**） | 跨 run 续跑游标（不透明）；回滚不该带；判定不读世界。**必须随队列项落 owner 持久存储**，跨宿主重启仍可续跑 |
| `at` / `expires_at` | 运行记录 | 时间元数据 |

**结论**：提问队列**无留在世界的定义字段**。留在世界的是 `Identity.schema`（数据契约 def，独立于队列）。
作答槽属 `input` 身份（同为运行记录，见 `plugins/input/README.md`）。

## 机制

1. 工具 `question` 入队：item 写自有存储（带 `{id, run, session, thread, questions, answers:null, resume:{command:'chat.resume', args:{cursor,thread}}, at, expires_at}`）；
   **不读 input 槽、也不清槽**（工具不消费 input）。
2. 本 run **正常结束**；`question.pending` 在**入队产出时即发**（乐观通知）。
3. 用户在卡上作答 → 写 input 槽 `{kind:'question.answer', id, answers}` → `question.answer` 入口 term 产
   `[eval(command:'chat.resume', args:{cursor, thread, payload:{answers}}, inject:{ids:['ids']}), extern(记答案 + 清槽回执)]` 续跑计划。
4. 宿主据 item 里的 `resume:{command:'chat.resume', args}` 起**新 run**，把答案回灌给 agent。

与审批的区别（写死）：审批 = `allow / deny` 门禁（改的是「能不能继续」）；question = 开放作答（补的是「缺的信息」）。
机制同源、语义不同，故分身份。

## 入口 term 为什么是 `eff`

term 语言只有八个原语，无法把「槽 id / answers」与「队列 item 的 resume 游标」拼装成新对象，也无法算哈希；
故 `terms/question.answer.json` 写成 `["eff","question","invoke",["c",null]]`——**投影读发生在服务侧**：
服务经 `input.read` 取本线程作答槽，沿自有存储定位 item 并回续跑计划（服务不读投影，D8）。`invoke` 按有无 `tool` 分流：
有 `tool` = 工具 `question`（入队，按工具契约回 `{ok:true, result:<值>}`）；无 `tool`（命令入口）= 作答，回顶层 `$directives`，
使入口 term 的返回值直接被宿主 plan 通道识别。续跑 eval 的 `inject:{ids:['ids']}` 由**宿主在执行期**注入投影切片。

## 渲染

`describe.render.detail.kind = "question"`；`invoke` 结果随附交互卡描述符
`{form:"card", label:"question", summary, tone:"plain", detail:{kind:"question", interactive:true, id, questions, expired, answers}}`，
`id` 供 ui-chat 提交 `question.answer` 定位 item，`expired` / `answers` 随消息 part 快照进 session，使 ui-chat 能提交 / 折叠 / 呈现 expired。

## 运行

```sh
npm test                       # 协议级 + 存储级 + 入口 term 真求值（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack/seed → start → loaded → 命令 run → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `terms/` / `execute/`）随源码入世。
