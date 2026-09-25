# approval（审批流程与回执）

待审批队列与裁决回执的服务件：队列项与 resume 游标住**服务自有持久存储**（④ `CHRONO_PLUGIN_DATA`），
**不进世界**——不产 `write` directive、不占 `seq`、不改 `worldRev`。服务不读投影、无写链通道：
队列读自有存储，方法只返回 `extern`（观测）与上行事件。本插件只按 `kind` 分类存储与回执，
不做判定、不做渲染、不做工具派发，**不自动裁决**。

- 能力类：`approval`；方法：`enqueue` / `list` / `decide` / `decide_all` / `sweep`。
- 命令：无（命令面由审批卡片插件声明；本插件不能 eff 调自己的服务，故入口 term 住在别的身份）。
- `pins`：无；不发 eff、不调其他插件。
- 状态档：`durable`（④ 不可重算）；`exclusive: ["data"]`（单写句柄，追加日志 + 内存索引要求单写者）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 时间：`at` / `decided_at` 取调用帧 `env.now`（宿主固定时钟）或 `args.at`；`id` 用 `run` + 入队序，服务不自取时钟、不用随机。

## 存储引擎与落点

- ④ `CHRONO_PLUGIN_DATA/approval.jsonl`：单文件追加日志，每条逻辑写一次 append + fsync（换行收尾）；
  启动重放即得全量队列。记录形态 `{t:'turn'|'write', run, ...}`：`write` 内 `ops` 为 `item`（upsert）/`count`（累计入队数）/`drop`（归档移除）。
- ③ `CHRONO_PLUGIN_STATE/index.json`：派生物（记录水位 / 累计计数 / 项数），删掉可由 ④ 重放重建，**不承载真源**。
- 回合标记 `{t:'turn', run, state:'open'|'closed'}`：存在 `open` 且无 `closed` 即中断残留，`pendingTurns()` 可辨识。
- **为何自写而非委托 `storage-*`**：裁决 / 续跑路径要求 enqueue 当场落账游标、decide 当场读回并改写，
  自写零协议往返、零审计；队列低频但游标必须在裁决同一步到位，自写避免跨进程往返与 pins 依赖。
  `state: "durable"` 由宿主保证跨代存活、进备份、只按身份消失回收。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

队列项（住自有存储）：

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `id` | 运行记录（出世界） | 队列项标识；回滚不该带；判定不从世界读 |
| `op_key` | 运行记录 | 幂等键（run + 审批节点序），服务内部 |
| `kind` | 运行记录 | 待审批种类，只用于模板选择与事件；门禁判据在 `guard`，不读它 |
| `port` | 运行记录 | 展示用提供者名；门禁判据在工具声明，不读队列项 |
| `method` | 运行记录 | 调用方法名；同上 |
| `args_ref` | 运行记录 | 摘要 / 资产引用；只展示，判定不读 |
| `tier` | 运行记录 | 触发档；判定由 `guard` 自判，不读队列项 |
| `workspace_id` | 运行记录 | 展示 / 归属元数据 |
| `run` / `thread` / `at` | 运行记录 | 回合 / 线程 / 时间元数据 |
| `status`（verdict 回执） | 运行记录 | **采纳闸不读它**：续跑裁决经 resume 游标 payload 传入 loop-policy（`resumeVerdict`），不经世界读 item.status；`status` 仅回执与展示 |
| `decided_at` / `by` | 运行记录 | 裁决回执元数据 |
| `resume`（含 `cursor`） | 运行记录（**owner 持久化**） | 跨 run 续跑游标（不透明）；回滚不该带；判定不读世界。**必须随队列项落 owner 持久存储**，跨宿主重启仍可裁决续跑 |
| `shadow`（`{def}`） | 运行记录（引用出世界） | 队列项里的引用是回执；**被引用的影子指标 def 属 `evolve-metrics`，仍留世界**（采纳闸经 `verdicts.gate.shadow` 读） |

**结论**：审批队列**无留在世界的定义字段**。留在世界的是 `Identity.schema`（数据契约 def，独立于队列）。
「采纳闸要读的判决 / 证据」不在本插件——它住 `loop-policy` / `evolution` 的 `verdicts`（判定平面，仍留世界）；
本插件的 `status` 只是回执。风险：若未来有人把采纳判据改成读 `approval` 队列项 `status`，须把它迁回世界——
当前不成立（机械证据见 `loop-policy` 的 `resumeVerdict` 走 resume payload）。

## 方法 args 契约

所有方法都要求 `args` 是对象；服务**不再接受** `queue` / `refs` / `slots` 切片（队列读自有存储，槽归 `input` 服务）。

### `enqueue`（由入队方 eff 调用）

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `kind` | string，必填 | `tool_call` / `orchestration_change` / `plugin_write`；非法 → `bad_args` |
| `port` | string，可缺 | 实际提供者能力类名；缺省按 `kind` 取 `orchestration-admin` / `plugin-admin`，`tool_call` 缺省 `tool` |
| `method` | string，可缺 | 调用方法名；缺省 `invoke` |
| `args_ref` | object，可缺 | `{sha256}` 或 `{summary}`；**不从明文 `args` 合成摘要** |
| `tier` / `workspace_id` / `run` / `thread` / `at` | 可缺 | 入队描述；`thread` 缺省取帧 `env.thread`、再缺省 `_main`；`at` 缺省取帧 `env.now` |
| `cursor` | 任意 JSON，可缺 | 调用方执行游标（不透明）；有则写进 `resume.args.cursor`，并据 `cursor.node_index` 生成幂等键 |
| `shadow` | object，可缺 | 仅 `orchestration_change`：影子回放指标 def 引用 `{def}` / 裸哈希 |
| `capacity` / `capacity_scope` | 可缺 | 覆盖 schema 容量（供调用方 / 测试）；非法忽略 |

- **边跑边追加**：入队即写 ④；同回合同 `op_key` 重复入队**幂等收敛**（回同一条，不重复计数）。
- **在产出时即发 `approval.pending` 事件**（乐观通知；载荷带 `run` / `thread` / `id` / `kind` / `port` / `tier` / `at`）。
- 队列满（容量按 `policy.capacity_scope` 计）→ 结构化拒：`extern{ok:false, reason:"queue_full", capacity, counted}`，**无写**、不静默丢。

### `list`（只读）

`args = {}`；只回一条 `extern{ok:true, version, count, pending, expired, decided, items}`（item 按到达序 oldest→newest），**不产写、不发事件**。

### `decide` / `decide_all`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `id` | string，可缺 | `decide` 的目标 item id；缺省回落调用方读到的槽 `id`（由 `ui-approval` 解析后传入） |
| `verdict` | string，可缺 | `accept` / `deny` |
| `thread_id` | string，可缺 | 槽键（仅记录用）；缺省 `_main` |
| `at` | string，可缺 | 裁决时间；缺省取帧 `env.now` |

- `decide`：把目标 item（`pending` 或 `expired`）迁到 `approved` / `denied`（`decided_at` / `by:"user"`），写自有存储；发 `approval.decided`；
  回 `extern{ok:true, id, status, verdict, thread, resume}`——`resume` 供调用方拼续跑计划，**不产世界写**。
- `decide_all`：对当前全部 `pending` 项批量给同一 verdict，逐项发 `approval.decided`；回 `extern{ok:true, ids, status, verdict, resumes}`。
- **清槽归 `ui-approval`**：输入槽属 `input` 服务（运行记录），由命令调用方经反向调用 `input.clear` 清理，本插件不碰。
- 目标不存在 / 缺 `id` / 坏 `verdict` / 无 pending → 结构化拒（`extern{ok:false, reason}`），无部分写。

### `sweep`（宿主周期方法）

`args` 可带 `timeout_ms` / `capacity` / `archive_keep` / `capacity_scope` 覆盖；**不再需要宿主注入投影片段**（读自有存储）。

- 超时判定：`pending` 且 `timeout_ms` 非 null 且 `env.now - Date.parse(item.at) >= timeout_ms` → 存储内改 `status:"expired"`；**只标状态、不自动裁决、不发终局事件**。
- 归档：非 `pending` 项（终局 + 过期）超过 `archive_keep` 时，从活动队列移除最旧者；**不删 pending**、不自动裁决。
- 无超时且无归档 → 只回 `extern{ok:true, changed:false, …}`，**无写**。

## 事件

事件是**乐观通知**（随应答一起发；计划被取消时可能有罕见假事件，UI 以重新拉取定稿）。

| topic | 触发 | 载荷 |
| --- | --- | --- |
| `approval.pending` | 新项入队 | `run` / `thread` / `id` / `kind` / `port` / `tier` / `at` / `count` |
| `approval.decided` | 裁决（单条 / 整批逐项） | `run` / `thread` / `id` / `kind` / `status` / `verdict` |

## 边界

- 不做判定（语义门归 `guard`）、不做渲染（卡片归 `ui-approval`）、不做工具派发（归 `tools`）。
- 不自动裁决：超时只标 `expired` 并保留在队列，是否终止 / 继续等由入队方判定。
- **存量不搬**：新存储从空开始，旧世界世代留在链上但不再被读。
- 不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）；服务无写链通道，只回 extern 与事件。

## 运行

```sh
npm test                     # 协议级 + 存储级测试（node --test）
node tools/e2e-smoke.mjs     # 宿主装配 E2E（pack → seed → periodic/.worldignore 校验 → start/stop → verify/replay → 直连协议）
```
