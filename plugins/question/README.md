# question（向用户提问并等待回答）

agent 向用户提问并等待作答：工具 `question` 把问题队列项写进世界后**本回合正常结束**（不阻塞、不用 `eff`
等待），用户作答后续跑，把答案回灌为本次工具调用的结果。队列进世界、可回放、重启保留。

- 能力类：`question`（`describe` / `invoke` / `list` / `sweep`）。`pins` 为空——不调其他身份、无反向调用。
- 命令：`question.answer`（入口 `terms/question.answer.json`）。
- 事件：入队计划产出时上行 `question.pending`（载荷带 `run` / `thread` / 队列项 id），供通知面消费。
- 状态档：`recomputable`（③ 可重算）。启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖；服务不读投影、无写通道、不取时间 / 随机（`at` / `now` 由 bag / env 传入），同输入同输出。

## 机制（复用 approval 的「队列进世界 + 跨 run 续跑」）

提问不是阻塞：受调用超时约束，`eff` 不能等人。故走与审批同源的形状——

1. 工具 `question` 产**写计划**：队列项进世界（item 带 `{id, run, session, thread, questions, answers:null, resume:{command:'chat.resume', args}, at, expires_at}`）；
   **不读 input 槽、也不清槽**（工具不消费 input，清槽会误擦本线程输入槽）。
2. 本 run **正常结束**；`question.pending` 在**入队计划产出时即发**（乐观通知）。
3. 用户在卡上作答 → 写 input 槽 `{kind:'question.answer', id, answers}` → `question.answer` 入口 term 产
   `[eval(command:'chat.resume', args:{cursor, thread, payload:{answers}, ids}), write(记答案（标 answered）+ 清槽)]` 续跑计划。
4. 宿主据 item 里的 `resume:{command:'chat.resume', args}` 起**新 run**，把答案回灌给 agent。

续跑 args 自带 `ids`：内核 term 不能同时传 args 与投影，续跑 eval 无法再以 `["g",["ids"]]` 取投影，
故由入口 term 把收到的投影切片原样放进 args，供 chat 服务装配 interpret bag（先例见 ui-sidebar `reveal` / ui-settings `search`）。

与审批的区别（写死）：审批 = `allow / deny` 门禁（改的是「能不能继续」）；question = 开放作答（补的是「缺的信息」）。
机制同源、语义不同，故分身份。

## 数据契约

`schema/question.json` 声明：

- 世界 body：`{version, tail, count}`；`tail` = 最新 item def 引用 `{"def":"<64hex>"}` 或 null；`count` = 累计入队数。
- item def：各自成 def、`prev` 成链；投影引用闭包进 `ids.question.refs`。作答 / 过期各追加一条同 id 的新版本 def，
  **不删旧 def**（`question.sweep` 只动 `tail`，不改 `count`）。
- 本插件自用参数：`max_questions` / `max_options` / `allow_custom` / `expires_ms`（缺省见 schema）。
- 顶层机械消费键：`periodic`（`method:'sweep'`，`reads` 注入 `ids.question.body` / `.refs`）、`method_timeouts`。

## 入口 term 为什么是 `eff`

term 语言只有八个原语，无法把「槽 id / answers」与「队列 item 的 resume 游标」拼装成新对象，也无法算哈希；
故 `terms/question.answer.json` 写成 `["eff","question","invoke",["g",["ids"]]]`——**投影读发生在 term**（`["g",…]`），
服务只收数据、沿 `tail` 链定位 item 并回计划（服务不读投影，D8）。`invoke` 按有无 `tool` 分流：
有 `tool` = 工具 `question`（入队，按工具契约回 `{ok:true, result:<写计划值>}`）；无 `tool`（投影 ids）= 作答命令入口，
回顶层写计划值（`$directives`），使入口 term 的返回值直接被宿主 plan 通道识别。

## 渲染

`describe.render.detail.kind = "question"`；`invoke` 结果随附交互卡描述符
`{form:"card", label:"question", summary, tone:"plain", detail:{kind:"question", interactive:true, id, questions, expired, answers}}`，
`id` 供 ui-chat 提交 `question.answer` 定位 item，`expired` / `answers` 随消息 part 快照进 session，使 ui-chat 能提交 / 折叠 / 呈现 expired。

## 运行

```sh
npm test                       # 协议级 + 入口 term 真求值（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack/seed → start → loaded → 命令 run → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `terms/` / `execute/`）随源码入世。
