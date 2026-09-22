# approval（审批流程与回执）

待审批队列与裁决回执的服务件：队列进世界（可回放、重启保留），item 各自成 def、以 `prev` 串成链。
服务本身**不读投影、没有写通道**——一切世界数据由调用方入口 term 读出后随 `args` 传入
（周期路径由宿主按 `schema.periodic.reads` 机械注入 bag），服务只返回**写计划**（`$directives`）与**上行事件**，
宿主机械落账、透传事件。本插件只按 `kind` 分类存储与回执，不做判定、不做渲染、不做工具派发，**不自动裁决**。

- 能力类：`approval`；方法：`enqueue` / `list` / `decide` / `decide_all` / `sweep`。
- 命令：无（命令面由审批卡片插件声明；本插件不能 eff 调自己的服务，故入口 term 住在别的身份）。
- `pins`：无；不发 eff、不调其他插件。
- 状态档：`recomputable`（服务进程不留持久状态）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 时间：`at` / `decided_at` 取调用帧 `env.now`（宿主固定时钟）或 `args.at`；`id` 用 `run` + 入队序，服务不自取时钟、不用随机。

## 数据契约 `schema/approval.json`

队列 body（小、可回放）：

```jsonc
{ "version": 1,
  "tail": { "def": "<最新 item def 哈希>" } | null,   // null = 空队列
  "count": 0 }                                          // 累计入队数（单调；裁决 / 过期 / 归档不改）
```

item def（各自成 def、`prev` 成链；投影引用闭包进 `ids.approval.refs`）：

```jsonc
{ "id": "ap-<run>-<seq>",                 // 确定性 id（run + 入队序），非随机
  "kind": "tool_call" | "orchestration_change" | "plugin_write",
  "port": "tool-fs" | "tool-shell" | "tool-http" | "tool-browser" | "mcp" | "orchestration-admin" | "plugin-admin",
  "method": "invoke",
  "args_ref": { "sha256": "…" } | { "summary": "…" },  // 只存摘要 / 资产引用；明文密钥不入世界
  "tier": "…", "workspace_id": "…", "run": "…", "thread": "…", "at": "…",
  "status": "pending" | "approved" | "denied" | "expired",
  "decided_at": "…" | null, "by": "user" | null,
  "resume": { "command": "chat.resume", "args": { "cursor": "<调用方执行游标，不透明>", "thread": "…" } } | null,
  "shadow": { "def": "<影子回放指标 def>" } | null,     // 仅 orchestration_change
  "prev": { "def": "<上一 item 哈希>" } | null }
```

- **verdict 词汇映射（写死）**：槽 `verdict` 枚举 `accept` / `deny` → item `status` `approved` / `denied`。
  `expired` 仅由超时产生，无对应槽值。
- `count` = 累计入队数（单调递增）；`id` 的 `seq` 取**入队前**的 `count`，故 id 在裁决 / 归档后仍唯一。
- item 链是**追加**的：裁决 / 过期各追加一条同 `id` 的新版本 def，不整体重写；沿 `prev` 回溯、按 `id` 去重即得每个 item 的最新版本。

## 方法 args 契约

所有方法都要求 `args` 是对象；`enqueue` / `list` / `decide` / `decide_all` / `sweep` 都以 `queue`（队列 body）与 `refs`（投影引用闭包）为世界数据入口。

### `enqueue`（由入队方 eff 调用）

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `queue` / `refs` | object，可缺 | 轮首队列 body 与引用闭包；缺省视为空队列 |
| `kind` | string，必填 | `tool_call` / `orchestration_change` / `plugin_write`；非法 → `bad_args` |
| `port` | string，可缺 | 实际提供者能力类名；缺省按 `kind` 取 `orchestration-admin` / `plugin-admin`，`tool_call` 缺省 `tool` |
| `method` | string，可缺 | 调用方法名；缺省 `invoke` |
| `args_ref` | object，可缺 | `{sha256}` 或 `{summary}`；**不从明文 `args` 合成摘要** |
| `tier` / `workspace_id` / `run` / `thread` / `at` | 可缺 | 入队描述；`thread` 缺省取帧 `env.thread`、再缺省 `_main`；`at` 缺省取帧 `env.now` |
| `cursor` | 任意 JSON，可缺 | 调用方执行游标（不透明）；有则写进 `resume.args.cursor` |
| `shadow` | object，可缺 | 仅 `orchestration_change`：影子回放指标 def 引用 `{def}` / 裸哈希 |
| `capacity` / `capacity_scope` | 可缺 | 覆盖 schema 容量（供调用方 / 测试）；非法忽略 |

- 计划 ops：`put(item)` → `put(新 body, tail={"def":{"$n":0}}, count+1)` → `add_gen(approval, {"$n":1})`。
- **在计划产出时即发 `approval.pending` 事件**（乐观通知；载荷带 `run` / `thread` / `id` / `kind` / `port` / `tier` / `at`）。
- 队列满（容量按 `policy.capacity_scope` 计）→ 结构化拒：只有一条 `extern{ok:false, reason:"queue_full", capacity, counted}`，**无写**、不静默丢。

### `list`（只读）

`args = {queue, refs}`；只回一条 `extern{ok:true, version, count, pending, expired, decided, items}`（item 按到达序 oldest→newest），**不产写、不发事件**。

### `decide` / `decide_all`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `queue` / `refs` | object，可缺 | 轮首队列 body 与引用闭包 |
| `slots` | object，必填（清槽用） | 轮首整份输入 body（`{slots:{…}}`）；由调用方入口 term 读投影后传入 |
| `thread_id` | string，可缺 | 槽键（per-thread 键控）；缺省取目标 item 的 `thread`（`decide_all` 缺省 `_main`） |
| `id` | string，可缺 | `decide` 的目标 item id；缺省回落本线程 `approval.decide` 槽的 `id` |
| `verdict` | string，可缺 | `accept` / `deny`；缺省回落本线程 `approval.decide` 槽的 `verdict` |
| `at` | string，可缺 | 裁决时间；缺省取帧 `env.now` |

- `decide`：把目标 item（`pending` 或 `expired`）迁到 `approved` / `denied`（`decided_at` / `by:"user"`）。
  计划 ops：`put(更新后的 item)` → `put(新 body, tail={"def":{"$n":0}})` → `add_gen(approval, {"$n":1})` → `put(清槽整份 slots)` → `add_gen(input, {"$n":3})`；发 `approval.decided`。
- `decide_all`：对当前全部 `pending` 项批量给同一 verdict，逐项追加更新 def 并逐项发 `approval.decided`；同批清槽。
- **不产续跑计划**：裁决命令入口 term 自行拼 `[eval(command:'chat.resume', …), write(记裁决 + 清槽)]`；本插件只回自己的写计划。
- 目标不存在 / 缺 `id` / 坏 `verdict` / 无 pending → **清槽 + 结构化拒**（`extern{ok:false, reason}`），无部分写；无 `slots` 时只回 extern。

### `sweep`（宿主周期方法）

`args` 由宿主按 `schema.periodic.reads` 注入（`queue` / `refs`），可另带 `timeout_ms` / `capacity` / `archive_keep` / `capacity_scope` 覆盖。

- 超时判定：`pending` 且 `timeout_ms` 非 null 且 `env.now - Date.parse(item.at) >= timeout_ms` → 追加一条 `status:"expired"` 的新版本 def；**只标状态、不自动裁决、不发终局事件**。
- 归档：非 `pending` 项（终局 + 过期）超过 `archive_keep` 时，写**新索引**——按原序重建只含 `pending` 与保留项的 item 链（`prev` 重连），并 `put` 新 body（`tail` 指向新链头，`count` 不变）；**不删 pending**、原 def 仍在世界链上（可回放、可 `set_active` 回看）。
- 无超时且无归档 → 只回 `extern{ok:true, changed:false, …}`，**无写**。

## 事件

事件是**乐观通知**（随计划一起发；计划被取消时可能有罕见假事件，UI 以重新拉取定稿）。

| topic | 触发 | 载荷 |
| --- | --- | --- |
| `approval.pending` | 新项入队（计划产出时） | `run` / `thread` / `id` / `kind` / `port` / `tier` / `at` / `count` |
| `approval.decided` | 裁决（单条 / 整批逐项） | `run` / `thread` / `id` / `kind` / `status` / `verdict` |

## 边界

- 不做判定（语义门归 `guard`）、不做渲染（卡片归 `ui-approval`）、不做工具派发（归 `tools`）。
- 不自动裁决：超时只标 `expired` 并保留在队列，是否终止 / 继续等由入队方判定。
- 不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）；服务无写通道，只回计划与事件。

## 运行

```sh
npm test                     # 协议级测试（node --test）
node tools/e2e-smoke.mjs     # 宿主装配 E2E（pack → seed → periodic/.worldignore 校验 → start/stop → verify/replay → 直连协议）
```
