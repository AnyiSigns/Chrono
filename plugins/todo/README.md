# todo（任务清单 / 待办清单）

按会话键控的待办清单。清单本体是**运行记录**，已**出世界**：住 owner 委托存储（`storage-kv`，按 `env.emitter` 分命名空间），
不产 `write` directive、不占 `seq`、不改 `worldRev`。本插件是**服务**：写即时落委托存储（边跑边追加），
读从自有存储取；不读投影、无写链通道。

- 能力类：`todo`（`describe` / `invoke`）。
- 工具：`todo.write`（整表替换，即时写委托存储）/ `todo.read`（从委托存储读）。
- `pins`：`storage-kv` → `storage-kv`（清单读写经反向调用 `storage-kv.get/put/batch/list/dropNamespace`）。
- 成员：`execute` + `schema`；无命令。
- 状态档：`durable`（④ 不可重算；数据落存储服务库中本 owner 命名空间）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `conversations[<会话 id>].items[].id` | 运行记录（出世界） | 条目标识属运行数据；回滚不该带 |
| `conversations[<会话 id>].items[].text` | 运行记录 | 待办文本即运行记录本体 |
| `conversations[<会话 id>].items[].status` | 运行记录 | 条目状态属运行数据 |
| `conversations[<会话 id>].items[].priority` | 运行记录 | 排序权重属运行数据 |
| `conversations[<会话 id>].items[].at` | 运行记录 | 记录时间属运行数据 |
| `conversations[<会话 id>].items[].prev` | 运行记录（**随迁移消失**） | 原为世界 def 链指针；出世界后条目直接按数组存，无需链 |
| `conversations[<会话 id>].items.tail` | 运行记录（**随迁移消失**） | 原为链头 def 引用；出世界后无世界 def 可指 |
| `conversations[<会话 id>].items.count` | 运行记录（**随迁移消失**） | 冗余计数；出世界后由数组长度派生 |
| `max_items`（schema） | **定义 / 判定（留世界）** | `todo.write` 门禁阈值；回滚应带上；门禁要从世界读 |
| `max_text_length`（schema） | **定义 / 判定（留世界）** | 同上 |
| `statuses`（schema） | **定义 / 判定（留世界）** | 状态枚举门禁，留世界 |

**结论**：清单条目无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def，含限额 / 枚举）。

## 存储引擎与落点（委托 `storage-kv`）

- ④ 落点：`storage-kv` 的 `CHRONO_PLUGIN_DATA/<emitter>/log.jsonl`，`<emitter>` = 本身份（`todo`）。
- 键 `conv:<会话 id>` = `{run, at, items:[{id,text,status,priority?,at?}]}`；键 `turn:<回合 id>` = `{state:'open'|'closed', conv}`。
- **边跑边追加**：写先落 `open` 标记、再落数据并置 `closed`（同一回合 id）；中途崩留下的 `open` 标记即中断残留，可辨。
- **幂等**：同会话 / 同回合重复写同值幂等（覆盖同一键）。
- **存量不搬**：存储从空开始，旧世界世代留在链上但不再被读。

## 清理责任（owner 退役）

委托存储的命名空间**删不到**：宿主按身份回收只删得到 owner 自己的 ④ 目录，删不到 `storage-kv` 库里属于它的那份。
故 **owner 退役时由调用方调 `storage-kv.dropNamespace`**（`env.emitter` = `todo`）清理本 owner 数据；
宿主不代劳、不认识命名空间语义。漏调用即静默漏数据。README 义务见 `docs/plugins.md` §六。

## `todo.write`（整表替换）

入参（`todo.invoke` 的 `args.args`）：`items`（必填，完整条目数组）、
`at`（条目缺省时间，调用方入口 term 由帧 `env.now` 提供；服务**不取时间**）。
`todo.invoke` 的 bag 里可带 `session` / `session_id` 供解析会话 id。

- **整表替换**：每次写都是本会话新数组，不接旧值；其它会话键不动。
- **空数组 = 清空**：本会话键写空数组。
- 门禁：条数超 `max_items` → `too_many_items`；文本超 `max_text_length`（Unicode 码点）→ `text_too_long`；
  状态不在 `statuses` → `bad_status`；`items` 非数组 → `bad_args`；会话 id 缺失 → `bad_args`。
- 返回 `{ok:true, conversation_id, total, done, items}`；**不产 `$directives`、不落账、不入队、不等审批**。

## `todo.read`

从本会话键取条目（老→新，与写入顺序一致；不含内部字段）；无记录回空清单。
返回 `{items, total, done}`。会话 id 解析同 `todo.write`。

## 会话 id 与数据来源

- 会话 id 由服务从 bag 解析：`bag.session_id` 直给，或 `bag.session` 为字符串 / 投影切片
  `{body:{current}}`（调用方入口 term 读 `ctx.ids.session.body.current` 后随 bag 传入）；
  `args.conversation_id` 只作内部显式覆盖（不进 `argsSchema`，模型看不到）。
- **清单数据只来自委托存储**：调用方传的 `bag.todo` 被忽略（服务不读投影）。

## 工具面（`todo.describe`）

两个工具各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）与工具卡 `render` 描述符；
`caps` 与 sandbox 同形（`fs:{read:"none",write:"none"}`、`net:"none"`，不触盘、不触网）。`todo.invoke {tool, args}` 按工具名派发，
业务失败回 `{ok:false,error:{code,message}}`。

| 工具 | `form` | `label` | `summary` | `tone` | `detail.kind` | `idempotent` |
| --- | --- | --- | --- | --- | --- | --- |
| `todo.write` | `card` | `todo` | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | false |
| `todo.read` | `card` | `todo` | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | true |

## 跨插件登记

- `tools`：按工具类 `todo` 派发；工具名 `todo.write` / `todo.read`。
- `loop-policy`：收口门禁 `todo_incomplete` 读 `bag.todo`（有 `pending` / `in_progress` 项 ⇒ 不收口、继续 loop）；
  `bag.todo` 由调用方入口 term 问本服务（`todo.read`）后装配。
- `ui-threads`：顶栏待办标签位（按父会话隔离）。
- `session`：清单按会话 id 键控；当前会话 id 由服务从 `bag.session` / `bag.session_id` 解析。

## 结构化错误码

`bad_args`（缺必需参数 / 形态非法）、`too_many_items`、`text_too_long`、`bad_status`、`unknown_tool`、
`transport_failed`（委托存储不可用）。

## 运行

```sh
npm test                       # 协议级测试（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack/seed → start → loaded → stop → verify + 离线投影）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
