# short-memory（短期记忆：L1 会话摘要 + L2 工作区累积）

记忆 L1 / L2 的**运行记录本体**：已**出世界**，住本服务自有持久存储（④ `CHRONO_PLUGIN_DATA`），
不产 `write` directive、不占 `seq`、不改 `worldRev`。本服务只存结果、不判定；写即时落盘（边跑边追加），
读从自有存储取；跨身份的写方（`compress` / `memory-consolidate`）经能力调用问它。

- 身份：`short-memory`
- 能力类 / 方法：`short-memory` → `read` / `read_session` / `read_workspace` / `apply` / `pending`
- `pins`：`{}`（无身份级依赖、不发 `eff`）
- 状态档：`durable`（④ 不可重算；跨代存活、进备份、只按身份消失回收）；`exclusive: ["data"]`
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界） | 存储格式版本；回滚不该带；判定不从世界读 |
| `sessions[<会话 id>].summary.goal` | 运行记录 | 摘要内容属运行数据 |
| `sessions[<会话 id>].summary.decisions[]` | 运行记录 | 同上 |
| `sessions[<会话 id>].summary.facts[]` | 运行记录 | 同上 |
| `sessions[<会话 id>].summary.open_questions[]` | 运行记录 | 同上 |
| `sessions[<会话 id>].summary.files[]` | 运行记录 | 同上 |
| `sessions[<会话 id>].summary.next_steps[]` | 运行记录 | 同上 |
| `sessions[<会话 id>].covered_upto` | 运行记录 | 压缩边界属运行数据 |
| `sessions[<会话 id>].at` | 运行记录 | 记录时间属运行数据 |
| `sessions[<会话 id>].expires_at` | 运行记录 | TTL 时间戳属运行数据（TTL 判据由维护方执行） |
| `workspaces[<工作区 id>].summary.*` | 运行记录 | 累积摘要内容属运行数据 |
| `workspaces[<工作区 id>].sources[]` | 运行记录 | 贡献会话 id 属运行数据 |
| `workspaces[<工作区 id>].at` | 运行记录 | 记录时间属运行数据 |
| L1 TTL（24h） | **定义 / 判定（留世界，住 `memory-consolidate` schema `params.l1_ttl_ms`）** | 清理判定阈值；回滚应带上 |

**结论**：L1 / L2 无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def）与维护方的策略参数（阈值）。

## 存储引擎与落点

- ④ `CHRONO_PLUGIN_DATA/short-memory.jsonl`：单文件追加日志，每条一次 append + fsync（换行收尾）。
  启动重放即得全量状态；末行半写撕裂 / 坏行跳过（fail-open）。
- 记录形态：`{t:'l1'|'l2', run, id, record|null}`（record=null 即删除）、`{t:'turn', run, state:'open'|'closed'}`。
- **边跑边追加**：`apply` 先置回合 `open` 标记、再逐键落记录、再置 `closed`；中途崩留下的 `open` 标记即中断残留，
  `pending` 可辨。
- **幂等**：同键重复写同值短路；同回合重复写同值幂等。
- **存量不搬**：存储从空开始，旧世界世代留在链上但不再被读。

## 方法语义

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `read` | `{}` | `{version, sessions, workspaces}`（整份 L1 / L2） |
| `read_session` | `{id}` | `{id, record}`（record=null 即无） |
| `read_workspace` | `{id}` | `{id, record}` |
| `apply` | `{set_sessions?, del_sessions?, set_workspaces?, del_workspaces?}` | `{ok, changed}`；set 为 id→record（record=null 即删），del 为 id 数组 |
| `pending` | `{}` | `{turns:[…]}`（未闭合回合，中断残留） |

- 形态非法 → 结构化 `bad_args`。
- 服务不读投影、不产世界写计划、不自取时钟。

## 清理责任（owner 退役）

自写存储：owner 退役时宿主按身份回收删除 `state/data/<id>/`；本服务无需额外清理方法。

## 与压缩 / 维护的协作

- `compress.summarize` / `compact` / `extract` 经 `port.call short-memory.read` 取现状、算合并结果后
  `port.call short-memory.apply` 写回（读-改-写，绝不盲写整份）。
- `memory-consolidate.consolidate` / `sweep` / `edit` 同理：读 `read`、按 L1 TTL / L2 容量合并或裁剪后 `apply`。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
