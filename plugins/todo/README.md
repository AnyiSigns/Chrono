# todo（任务清单 / 待办清单）

按会话键控的待办清单。清单本体是**运行记录**，已**出世界**：住 owner 委托存储（`storage-kv`，按 `env.emitter` 分命名空间），
不产 `write` directive、不占 `seq`、不改 `worldRev`。本插件是**服务**：写即时落委托存储（边跑边追加），
读从自有存储取；不读投影、无写链通道。

- 能力类：`todo`（`describe` / `invoke`）。
- 工具：`todo`（单一工具，`action` 分派 `replace` 整表替换 / `update` 按 id 增量 / `read` 读自委托存储）。
- `pins`：`storage-kv` → `storage-kv`（清单读写经反向调用 `storage-kv.get/batch`）。
- 成员：`execute` + `schema`；无命令。
- 状态档：`durable`（④ 不可重算；数据落存储服务库中本 owner 命名空间）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 条目形状

`{ id, text, status, activeForm?, at? }`：

| 字段         | 说明                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `id`         | 稳定标识。写入 / 新增时缺省分配 `t<seq>`（`seq` 随会话持久化，单调递增）；整表替换带上从 `todo.read` 取回的 id 即保持身份。 |
| `text`       | 条目正文。                                                                                                                  |
| `status`     | 状态枚举（schema `statuses`，缺省 `pending` / `in_progress` / `completed` / `cancelled` / `blocked`）。                     |
| `activeForm` | 进行时描述（如「正在跑测试」），`in_progress` 时供 UI 展示；可缺省，更新时传空串清除。                                      |
| `at`         | 条目时间（ISO 8601）；缺省沿用本批缺省时间。                                                                                |

- **焦点唯一（缺省）**：同一清单至多一个 `in_progress`。`todo.write` 写入多个 → `multiple_in_progress`；
  `todo.update` 把某条置为 `in_progress` 时，自动把其它 `in_progress` 降回 `pending`（焦点切换）。
  复杂并行工作流可**显式 opt-in**：单次调用传 `allow_multiple_in_progress:true`，或 schema 置
  `allow_multiple_in_progress:true`，此时允许多个 `in_progress`，不再自动降级。
- `cancelled` = 放弃：不计完成、也不算未完成（`loop-policy` 的 `todo_incomplete` 不因它重入 loop）。
- `blocked` = 受阻：既不进行也不完成，用于「等外部依赖 / 待决策」的条目；与 `cancelled` 一样不计完成。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段                                                           | 判定                      | 理由                                                              |
| -------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| 条目全部字段（`id` / `text` / `status` / `activeForm` / `at`） | 运行记录（出世界）        | 条目标识 / 正文 / 状态 / 展示 / 时间均属运行数据；回滚不该带      |
| `max_items`（schema）                                          | **定义 / 判定（留世界）** | `todo.write` / `todo.update` 门禁阈值；回滚应带上；门禁要从世界读 |
| `max_text_length`（schema）                                    | **定义 / 判定（留世界）** | 同上                                                              |
| `statuses`（schema）                                           | **定义 / 判定（留世界）** | 状态枚举门禁；describe 与写入门禁同源现读                         |
| `allow_multiple_in_progress`（schema）                         | **定义 / 判定（留世界）** | 是否允许多个 `in_progress` 的判定；与调用级 opt-in 取或            |

**结论**：清单条目无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def，含限额 / 枚举）。

## 存储引擎与落点（委托 `storage-kv`）

- ④ 落点：`storage-kv` 的 `CHRONO_PLUGIN_DATA/<emitter>/log.jsonl`，`<emitter>` = 本身份（`todo`）。
- 键 `conv:<会话 id>` = `{run, at, seq, items:[{id,text,status,activeForm?,at?}]}`；键 `turn:<回合 id>` = `{state:'open'|'closed', conv}`。
- **边跑边追加**：写先落 `open` 标记、再落数据并置 `closed`（同一回合 id）；中途崩留下的 `open` 标记即中断残留，可辨。
- **幂等**：同会话 / 同回合重复写同值幂等（覆盖同一键）。
- **存量不搬**：存储从空开始，旧世界世代留在链上但不再被读。

## 清理责任（owner 退役）

委托存储的命名空间**删不到**：宿主按身份回收只删得到 owner 自己的 ④ 目录，删不到 `storage-kv` 库里属于它的那份。
故 **owner 退役时由调用方调 `storage-kv.dropNamespace`**（`env.emitter` = `todo`）清理本 owner 数据；
宿主不代劳、不认识命名空间语义。漏调用即静默漏数据。README 义务见 `docs/plugins.md` §六。

## `todo.write`（整表替换）

入参（`todo.invoke` 的 `args.args`）：`items`（必填，完整条目数组）、
`at`（条目缺省时间，调用方入口 term 由帧 `env.now` 提供；服务**不取时间**）、
`allow_multiple_in_progress`（可选，true 时允许多个 `in_progress`）。
`todo.invoke` 的 bag 里可带 `session` / `session_id` 供解析会话 id。

- **整表替换**：每次写都是本会话新数组，不接旧值；其它会话键不动。
- **空数组 = 清空**：本会话键写空数组。
- 门禁：条数超 `max_items` → `too_many_items`；文本 / `activeForm` 超 `max_text_length`（Unicode 码点）→ `text_too_long`；
  状态不在 `statuses` → `bad_status`；多个 `in_progress` → `multiple_in_progress`（除非 `allow_multiple_in_progress:true`）；
  id 重复 → `bad_args`；`items` 非数组 → `bad_args`；会话 id 缺失 → `bad_args`。
- 返回 `{ok:true, conversation_id, total, done}`；**不回传全表**、不产 `$directives`、不落账、不入队、不等审批。

## `todo.update`（按 id 增量）

入参：`ops`（必填、非空操作数组，按序作用于演进中的清单）、`at`（新增条目缺省时间）、
`allow_multiple_in_progress`（可选，true 时置 `in_progress` 不降级其它项）。

| op       | 必填           | 语义                                                                                                                            |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `add`    | `text`         | 追加新条目（自动分配稳定 id）；`status` / `activeForm` / `at` 可选。                                                            |
| `update` | `id`           | 改 `text` / `status` / `activeForm` / `at`（只改给出的字段；`activeForm:""` 清除）。置 `in_progress` 会降级其它 `in_progress`（`allow_multiple_in_progress:true` 时除外）。 |
| `remove` | `id`           | 删除该条目。                                                                                                                    |
| `move`   | `id` / `index` | 把该条目移到下标 `index`（0 基，越界收敛到末位）。                                                                              |

- id 不存在 → `item_not_found`；`op` 非法 → `unknown_op`；条数超限 → `too_many_items`；状态越界 → `bad_status`。
- 返回 `{ok:true, conversation_id, total, done, changed}`；`changed` = 本次受影响条目（`remove` 为 `{id, removed:true}`、
  `move` 为 `{id, index}`）。

## `todo.read`

从本会话键取条目（老→新，与写入顺序一致；只含对外声明字段）；无记录回空清单。
返回 `{items, total, done}`。会话 id 解析同 `todo.write`。

## 会话 id 与数据来源

- 会话 id 由服务从 bag 解析：`bag.session_id` 直给，或 `bag.session` 为字符串 / 投影切片
  `{body:{current}}`（调用方入口 term 读 `ctx.ids.session.body.current` 后随 bag 传入）；
  `args.conversation_id` 只作内部显式覆盖（不进 `argsSchema`，模型看不到）。
- **清单数据只来自委托存储**：调用方传的 `bag.todo` 被忽略（服务不读投影）。

## 工具面（`todo.describe`）

单一 `todo` 工具带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）与工具卡 `render` 描述符；
状态枚举 describe 时现读 schema，与写入门禁同源。`caps` 与 sandbox 同形（`fs:{read:"none",write:"none"}`、`net:"none"`）。
`todo.invoke {tool, args}` 按工具名与 `args.action` 派发；旧名 `todo.write` / `todo.update` / `todo.read` 仍被 invoke 接受（仅内部调用方使用，
目录里只广告合并后的 `todo`）。业务失败回 `{ok:false,error:{code,message}}`。

| 工具   | `action`  | `form` | `label` | `summary`               | `tone`  | `detail.kind`                   | `idempotent` |
| ------ | --------- | ------ | ------- | ----------------------- | ------- | ------------------------------- | ------------ |
| `todo` | `replace` | `card` | `todo`  | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | false        |
| `todo` | `update`  | `card` | `todo`  | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | false        |
| `todo` | `read`    | `card` | `todo`  | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | false        |

合并前三个动作各是一个工具（`todo.read` 原为幂等、`ghost` 色）；合并后同一工具只能有单个 `detail.kind` / `tone` / `idempotent`，
取 `list` / `plain` / `false`——展开渲染与只读语义不变，仅丢 `read` 的结果缓存与 `ghost` 色。

## 跨插件登记

- `tools`：按工具类 `todo` 派发；目录里工具名 `todo`（旧名 `todo.write` / `todo.update` / `todo.read` 仅内部调用方直达 invoke）。
- `loop-policy`：收口门禁 `todo_incomplete` 读 `bag.todo`（有 `pending` / `in_progress` 项 ⇒ 不收口、继续 loop；
  `cancelled` 不算）；`bag.todo` 由调用方入口 term 问本服务（`todo.read`）后装配。
- `ui-threads`：顶栏待办标签位（按父会话隔离；`in_progress` 展示 `activeForm`，`cancelled` 置灰）。
- `session`：清单按会话 id 键控；当前会话 id 由服务从 `bag.session` / `bag.session_id` 解析。

## 结构化错误码

`bad_args`（缺必需参数 / 形态非法 / id 重复）、`unknown_tool`、`unknown_op`、`item_not_found`、
`too_many_items`、`text_too_long`、`bad_status`、`multiple_in_progress`、`transport_failed`（委托存储不可用）。

## 运行

```sh
npm test                       # 协议级测试（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack/seed → start → loaded → stop → verify + 离线投影）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
