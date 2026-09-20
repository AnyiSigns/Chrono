# #47 `todo`（任务清单 / 待办清单）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 47 / `todo` |
| 职责 | **隔离的任务清单 / 待办清单**（持久化进世界，**按会话键控**）+ 工具 `todo.write` / `todo.read` + 顶栏渲染位（有未完成项即出现）；**兼作收口门禁的数据源** |
| 依赖 | `<-` 27（pins：工具类 `todo` 派发）；`<-` 46（顶栏标签读投影）；`<-` 33（投影读：收口门禁 `todo_incomplete`）；`+` 11（当前会话 id 由调用方入口 term 读 `ctx.ids.session.body.current` 后经 args 传入；本插件服务**不读投影**，D8） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["todo"]`，`methods: {"todo":["describe","invoke"]}`（**类名 = 身份名**，见 `plugins/tools/DESIGN.md`）；`describe` 回工具名 `todo.write` / `todo.read` |
| 命令 | 无 |
| schema | `schema/todo.json`（条数上限 / 文本长度上限 / 状态枚举；可热改） |
| 机制 | 见下「数据 / 工具 / 收口门禁 / 渲染」 |
| 边界 | 不做：判定"是否真做完"（完成与否由 agent 更新 + 图**机械**检查未完成项）/ 写其他身份 / 长期知识（归 #21 `memory-store`） |
| 验收 | 1) 清单跨 run 持久、可回放；2) `todo.write` **按会话键**整表替换可回放（旧 def 仍留链上）；3) **有未完成项时图不收口**（继续 loop）；4) 全部 `completed` / 清空后才允许收口；5) 顶栏标签随清单出现 / 消失；6) 换渲染实现不改 #27 |
| 状态 | 新增（2026-09-19） |

## 数据

- 清单住世界：**按会话键控** body（`{ "conversations": { "<conversation_id>": { "items": { "tail": {def:hash}, "count": n } } } }`，每个会话的条目各自成 def + 链式 `tail`；宿主投影引用闭包解析复用 #11 / #21 / #35 同一条）。
- 条目：`{ id, text, status: "pending" | "in_progress" | "completed", priority?, at }`。
- **持久化是重点**：清单**不随 run 结束消失**，跨 run / 跨续跑都在；agent 每次更新都是一次可回放的世界写。

## 工具

| 工具名 | 幂等 | 说明 |
| --- | --- | --- |
| `todo.write` | ✗ | **整表替换**（同 `todowrite` 语义）：传完整条目数组，产写计划（新条目 defs + **本会话键的新 body**（`conversations[<id>].items.tail` 指向新链头）+ `add_gen`）；**只重写本会话键、旧 def 仍留链上**（可回放）；空数组 = 该会话清空 |
| `todo.read` | ✓ | 投影读**当前会话**键的清单（`conversations[<conversation_id>]`）；返回 `{items:[…]}` |

- 两个工具都各自声明 `argsSchema` 与 `caps`（无 fs / 无 net）；`todo.read` 幂等可缓存。
- **会话 id 入参**：两个工具都以 `conversation_id` 为 args 入参，由 #27 入口 term 读 `ctx.ids.session.body.current` 后传入；本插件服务**不读投影**（D8）。

## 收口门禁（防"幻觉式收尾"，关键）

- **问题**：agent 做着做着"以为做完了"就收口终止——清单只在模型脑内，一收口就没了依据。
- **解药（机械的）**：清单**进世界** ⇒ #33 在 sink 前（收口判定）**投影读当前会话键 `conversations[<id>]` 的清单**，新增种子判定 **`todo_incomplete`**：存在 `pending` / `in_progress` 项 ⇒ **不收口、继续 loop**（进 `Graph.loop.when`）。
  - agent 要收口，**必须显式把清单更新为全 `completed`（或清空）**——把"我完成了"从口头断言变成**一次可审计的世界写**。
  - 终止性仍由 `thresholds.max_turn_iter` 保证（坏图必终止，见 #33）。
- **口径**：门禁只查"清单是否被显式收尾"，**不判"做得对不对"**（后者是 `verify` / 人的事）。

## 渲染

- **工具卡**（各工具自带，见 #27「工具卡渲染」）：
  ```jsonc
  { "form": "card", "label": "todo", "summary": "{done}/{total} 已完成", "tone": "plain",
    "detail": { "kind": "list", "fields": ["text", "status"] } }
  ```
- **顶栏标签位（#46 `ui-threads`）**：当前（父）会话键 `conversations[<id>]` **有未完成项**时，顶栏出现「待办 N」标签；点开显示清单（只读，逐项状态）；全部完成 / 清空后标签消失。
- **顶栏内容按父会话隔离**：标签集合与待办标签都只属于**当前父会话**（切换父会话即换一组标签），见 #46。

## 跨插件登记

- **#27 tools**：按工具类 `todo` 派发；工具名 `todo.write` / `todo.read`。
- **#33 loop-policy**：新增种子判定 `todo_incomplete`，进 `Graph.loop.when`；#33 `+ 47` 投影读**当前会话键**清单（字面身份名、不产生依赖边）。
- **#46 ui-threads**：顶栏待办标签位（按父会话隔离）。
- **#11 session**：清单按会话 id 键控（`conversations[<conversation_id>]`）；当前会话 id 由调用方入口 term 读 #11 投影后经 args 传入（不改 #11 schema，D8）。
