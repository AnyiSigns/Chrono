# chat（回合命令面 + 装配服务 + 接线）

Chrono 的对话回合入口：把「用户消息已入输入槽」翻译成一次 `loop-policy.interpret` 调用，
并把解释器与标题段返回的写计划机械合并成顶层计划值交宿主落账。
本包是**有执行件的身份**：成员 = `execute/`（装配服务）+ `terms/`（三个命令入口）+ `schema/`（接线数据）。

## 身份与依赖

- 身份：`chat`；`implements: ["chat"]`、`methods: { chat: ["send", "history", "resume"] }`、`start: "node execute/main.ts"`。
- `pins`：`session` → `session`、`model` → `model-protocol`、`context` → `context-window`、
  `session-title` → `session-title`、`loop-policy` → `loop-policy`。
- 入口 term 是**自能力路由**（无自引用 pin）：
  `["eff","chat","send",["g",["ids"]]]` / `["eff","chat","history",["g",["ids"]]]` /
  `["eff","chat","resume",["v",0]]`——前两者只把投影切片交给自己的服务，`resume` 收调用方随 plan eval 传入的 args。
- 服务不读投影、不写链、不自取时钟（`now` 用调用帧 `env.now`）：世界数据由入口 term 读出随 args 传入。

## 命令

| 命令 | 语义 |
| --- | --- |
| `chat.send`（无参） | 服务按 `call` 帧 `env.thread` 取线程键，读投影 `ids.input.body.slots[<thread>]` 的 kind：`chat.message` → 跑管道；空槽 / `idle` / 非 chat kind → 幂等 no-op（`extern{ok:true,noop:true}`，不触发任何下游 eff）。 |
| `chat.history` | **v1 契约**：入口 term 只传投影 `["g",["ids"]]`，服务读 `ids.session` 的 `body` + 全量 `refs`，沿 `prev` 从链头还原展示序并**整体返回**（`messages` 全链 + `body` + `refs`）；客户端沿 `prev` 自行还原与切窗。命令 args `{conversation,before,limit}` 到不了服务；服务侧 `parseHistoryQuery` / `sliceChain` 切片能力保留为后置。**不触发下游 eff、不写链**——声明为**只读命令**（`readonly: true`），宿主不广播其 `run.started` / `run.finished`、不落审计、不推进链头。 |
| `chat.resume`（args `{cursor, thread, payload?, ids?}`） | 跨 run 续跑：装配与 send 相同的 interpret bag，另加 `bag.resume={cursor,thread,payload}` 交 loop-policy 恢复执行，合并计划返回。**`ids` = 调用方随 plan eval 传入的投影切片**（内核 term 不能同时传 args 与投影）。 |

管道（`chat.send` 的 `chat.message` 分支）：

```
loop-policy.interpret           // interpret bag 一次覆盖全部节点；loop-policy 自驱解释器按节点分发
  └ 首条用户消息时旁路 session-title.generate
```

- 段序归 loop-policy 图数据（改图 = 数据换代热生效）；本包不再持静态管道。
- 服务按 bag 装配契约装配 interpret bag：`input` / `config` / `tier` / `memories` / `session` / `graph` /
  `persona` / `skills` / `workspace_root` / `evidence` / `todo` / `guard_rules` / `sandbox_tiers` /
  `tools_bindings` / `mcp_tools` 等（缺对应身份即省略，由 loop-policy 回落种子 / 内建兜底）。
- interpret 段与 title 段返回的 `$directives` **按段序机械合并**为顶层 `$directives`（数组拼接，不构造新 JSON 对象）。
- 首条用户消息判定：投影里当前会话 `title` 仍为缺省「新对话」且 `count == 0`。
  标题段 `on_fail = ignore`：该段传输失败 / 无计划一律跳过，不影响主回合。
- 空槽行为 `on_empty_slot: "noop"`；连接配置缺失 → `model_not_configured`，不派发 interpret。
- 系统提示词 / 工具 schema 的缺省来源 = `schema/wiring.json` 的 `system_prompt` / `tools`，
  随 interpret bag 传入；loop-policy 图内 `context.assemble` 写 bag 覆盖。

## 为什么装配下沉到服务

内核 term 只有八个原语，且**无对象 / 列表构造**、`if` 只收 Bool、`["g"]` 缺失即 `missing_path`——
入口 term 无法装配多切片 bag，也无法把各段 `$directives` 合并成顶层计划值。
故本包把**装配 / 分支 / 切片 / 合并**全部下沉到自己的 `execute` 服务；
入口 term 只传投影切片（`["g",["ids"]]`）或续跑 args（`["v",0]`）。

## 接线数据 `schema/wiring.json`

该文件既是身份自述，也是服务启动时读到的接线数据。字段：`slices` / `system_prompt` / `tools` /
`title` / `on_empty_slot` / `on_budget` / `stream`。段序不在此（归 loop-policy 图数据）；
`title.title_default` 声明会话缺省标题（与 session 新建会话一致）。

## 怎么起

宿主按 `start: "node execute/main.ts"` 起服务：服务自实现 stdio 帧协议，stdout 只发协议帧、
日志走 stderr，stdin EOF / 管道断开即自退出。入世后命令即可被路由到。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 测试

`npm test`（`node --test`）：包形状 / 接线 / term 入口 / 服务协议级（驱动桥接 `loop-policy.interpret`
与 `session-title.generate` 假实现，覆盖空槽 no-op、interpret bag 键完整性、`$directives` 合并、
title 触发与失败跳过、`chat.resume` 的 `args.ids` 装配与 `bag.resume` 透传、`chat.history` 链还原与切片）。
`tools/e2e-smoke.mjs`：boot CLI pack/seed chat 及其 pins 闭包（含 `loop-policy`），
核对声明 / 命令（含 `chat.resume`）/ pins 解析 / 自能力入口解析 / `.worldignore`。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/` / `terms/` / `schema/`）随源码入世。
