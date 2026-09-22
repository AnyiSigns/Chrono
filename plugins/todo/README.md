# todo（任务清单 / 待办清单）

按会话键控的待办清单：清单**进世界持久化**（跨 run / 跨续跑都在），agent 每次更新都是一次可回放的世界写。
本插件是**服务**，不读投影、无写通道：`todo.write` 只产写计划，`todo.read` 只解析调用方传入的投影数据。

- 能力类：`todo`（`describe` / `invoke`）。
- 工具：`todo.write`（幂等 ✗，整表替换，产写计划）/ `todo.read`（幂等 ✓，能力类工具绑定、method 缺省 = 投影读）。
- `pins`：`{}`（无身份级依赖、不发 `eff`）。
- 成员：`execute` + `schema`；无命令。
- 状态档：`recomputable`（③ 可重算）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 数据（住世界、按会话键控）

body 顶层 `conversations` 以会话 id 为键，每个会话只存链头与条数：

```jsonc
{ "conversations": { "<conversation_id>": { "items": { "tail": { "def": "<64hex>" } | null, "count": 2 } } } }
```

- 条目 `{ id, text, status: "pending" | "in_progress" | "completed", priority?, at }`；每条各自成 def，
  以 `prev: { "def": "<上一条哈希>" }` 串成链，`tail` 指最新一条。
- 引用用显式标记 `{"def":"<64hex>"}`，宿主构造投影时把可达 def body 放进 `ids.todo.refs`（与 session / memory-store 同一招）。
- `max_items` / `max_text_length` / `statuses` 是 `schema/todo.json` 顶层的限额与枚举，服务**按调用时读取**
  （schema 成员变化属数据、可热改）；文件不可读时回落常量 200 / 500 / 三态枚举。

## `todo.write`（整表替换）

入参（`todo.invoke` 的 `args.args`）：`conversation_id`（必填）、`items`（必填，完整条目数组）、
`at`（条目缺省时间，调用方入口 term 由帧 `env.now` 提供；服务**不取时间**）。
`todo.invoke` 的 bag 里可带 `todo`（调用方入口 term 读本插件投影后传入）与 `at`。

- 计划形状（批内 `{"$n":k}` 只指向更早的 `put`）：

  ```text
  put(条目 def) × n        # prev 串成新链，首条 prev = null
  put(新 body)             # 只替换本会话键：tail 指新链头、count = n；其它会话键原样保留
  add_gen('todo')          # payload / sig 指向 put(新 body)
  ```

- **整表替换**：每次写都是新链（首条 `prev = null`），不接旧链；**只重写本会话键**，其它会话键不动。
- **空数组 = 清空**：只 `put(tail:null, count:0)` + `add_gen`，无条目 def。
- **旧 def 仍留世界 `defs` 上**（内容寻址、append-only），故历史可回放；服务不删 def。
- 门禁：条数超 `max_items` → `too_many_items`；文本超 `max_text_length`（Unicode 码点）→ `text_too_long`；
  状态不在 `statuses` → `bad_status`；缺 `conversation_id` / `items` 非数组 → `bad_args`。
- 产出 `{$directives:[{kind:"write",request:{op:"batch",args:{ops}}},{kind:"extern",payload}]}`；
  **本插件不落账、不入队、不等审批**。

## `todo.read`（投影读）

`todo.read` 是**能力类工具绑定、method 缺省 = 投影读**：清单数据由**调用方入口 term**（chat 入口装配 `bag.todo` /
ui-threads `threads.state` 直读）读本插件投影后随 bag 传入，**本服务不自读投影**。入参 `conversation_id`（必填）。

- 接受的 bag 数据形态：已解析的 `{items}`，或投影片段 `{body, refs}` / 裸 body（经 `refs` 回溯条目链）。
- 返回 `{items, total, done}`（条目老→新，与写入顺序一致；不含链式 `prev`）；无该会话条目回空清单；
  数据缺失 → `missing_todo`，`refs` 缺失 / 环 → `missing_refs` / `todo_cycle`。

## 会话 id 与投影数据来源

- `conversation_id` 由调用方入口 term 读 `ctx.ids.session.body.current` 后随 args 传入。
- 待办投影（`bag.todo`）由调用方入口 term 读 `ctx.ids.todo.body` + `ctx.ids.todo.refs` 后随 bag 传入。
- 服务**不读投影、不收 `ctx`**；无 bag 数据时 `todo.read` 报 `missing_todo`、`todo.write` 只落本会话键。

## 工具面（`todo.describe`）

两个工具各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）与工具卡 `render` 描述符；
`caps` 与 sandbox 同形（`fs:{read:"none",write:"none"}`、`net:"none"`，不触盘、不触网）。`todo.read` 另带
`binding:{class:"todo",method:null}` 标明其为投影读绑定。`todo.invoke {tool, args, todo?, at?}` 按工具名派发，
业务失败回 `{ok:false,error:{code,message}}`。

| 工具 | `form` | `label` | `summary` | `tone` | `detail.kind` | `idempotent` |
| --- | --- | --- | --- | --- | --- | --- |
| `todo.write` | `card` | `todo` | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | false |
| `todo.read` | `card` | `todo` | `{done}/{total} 已完成` | `plain` | `list`（fields: text / status） | true |

## 跨插件登记

- `tools`：按工具类 `todo` 派发；工具名 `todo.write` / `todo.read`。
- `loop-policy`：收口门禁 `todo_incomplete` 读 `bag.todo`（有 `pending` / `in_progress` 项 ⇒ 不收口、继续 loop）。
- `ui-threads`：顶栏待办标签位（按父会话隔离）。
- `session`：清单按 `conversations[<conversation_id>]` 键控；当前会话 id 由调用方入口 term 读投影后经 args 传入。

## 结构化错误码

`bad_args`（缺必需参数 / 形态非法）、`too_many_items`、`text_too_long`、`bad_status`、`unknown_tool`、
`missing_todo`（read 未收到投影数据）、`missing_refs` / `todo_cycle`（条目链解析失败）。

## 运行

```sh
npm test                       # 协议级测试（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack/seed → start → loaded → stop → verify + 离线投影）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/`）随源码入世。
