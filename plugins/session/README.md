# session（会话运行记录 + 提交服务）

会话的**运行记录真源**：消息链与会话元数据住**服务自有持久存储**（④ `CHRONO_PLUGIN_DATA`），
**不进世界**——不产 `write` directive、不占 `seq`、不改 `worldRev`。服务读自己的存储后返回，
调用方（`chat`）经反向调用取用；服务不读投影、无写链通道、不自取时钟（`now` 取帧 `env.now`）。

- 能力类：`session`；方法：`commit` / `new_conversation` / `select` / `rename` / `set_title` / `delete` /
  `restore` / `branch` / `deliver` / `read` / `history`。
- 命令：无（命令面由侧栏 / 聊天插件承接）。
- `pins`：`input` → `input`（`commit` 等消费槽后经反向调用 `input.clear` 清本线程槽）。
- 状态档：`durable`（④ 不可重算；跨代存活、进备份、只按身份消失回收）；`exclusive: ["data"]`。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 存储引擎与落点

- ④ `CHRONO_PLUGIN_DATA/session.jsonl`：单文件追加日志，每条记录一次 append + fsync（换行收尾）。
  启动时重放即得全量状态；末行半写撕裂 / 坏行跳过（fail-open）。
- ③ `CHRONO_PLUGIN_STATE/index.json`：派生物（记录水位 / 会话计数），删掉可由 ④ 重放重建，**不承载真源**。
- 记录形态：`{t:'msg'|'conv'|'current'|'del'|'restore'|'turn', run, ...}`。
  - `msg`：`{run, conv, msg}`；消息 `id` 由回合 id + 角色派生，同回合同角色重复写幂等。
  - `conv`：`{run, entry}`；按 `id` 新增 / 替换会话条目。
  - `current`：`{run, id}`；`del` / `restore`：软删 / 恢复。
  - `turn`：`{run, conv, state:'open'|'closed'}`；**回合级标记**，存在 `open` 且无 `closed` 即中断残留，
    `read` 的 `pending_turns` 可辨识。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

会话 body（原世界数据世代）：

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界） | 回滚代码不该带上会话版本；判定不从世界读它 |
| `current` | 运行记录 | 当前会话选择是运行态；回滚不该带；判定经 `read`/bag 取 |
| `conversations[].id` | 运行记录 | 会话标识属运行数据 |
| `conversations[].workspace_id` | 运行记录（**留世界候选**） | 判定要读它（工作区根 → fs 门禁），但**经 owner 服务 `read` 进 bag**，不从世界投影读；回滚不该带。风险：owner 不可用时该判定输入缺失，由上层 fail-closed 处理 |
| `conversations[].title` | 运行记录 | 展示元数据 |
| `conversations[].kind` | 运行记录 | 线程种类属运行数据；经 bag 取（`thread_kind`） |
| `conversations[].parent` | 运行记录 | 线程树父指针属运行数据 |
| `conversations[].source_message` | 运行记录 | 分支源消息属运行数据 |
| `conversations[].agent` | 运行记录（**留世界候选**） | 人格经 bag 取（`persona`），非从世界投影读 |
| `conversations[].participants` | 运行记录 | 圆桌参与者属运行数据 |
| `conversations[].workflow` | 运行记录 | 工作流执行位置属运行数据 |
| `conversations[].inbox` | 运行记录 | 收件箱链头 / 计数属运行数据 |
| `conversations[].status` | 运行记录 | 线程处境属运行数据 |
| `conversations[].last_activity` | 运行记录 | 最近活动属运行数据 |
| `conversations[].pending` | 运行记录 | 待办计数属运行数据 |
| `conversations[].head` | 运行记录 | 链头指针属运行数据（现指向服务存储内的消息 id） |
| `conversations[].count` | 运行记录 | 条数冗余属运行数据 |
| `conversations[].created` | 运行记录 | 创建时间属运行数据 |
| `conversations[].deleted_at` | 运行记录 | 软删标记属运行数据 |
| 消息 def `id/role/content/parts/attachments/meta/at/prev` | 运行记录 | 对话消息即运行记录本体 |
| `messageDef` | 运行记录 | 仅形状说明，非数据 |

**结论**：会话 body 无留在世界的定义字段；留在世界的是 `Identity.schema`（数据契约 def，独立于 body）。
判定要读的 `workspace_id` / `agent` / `kind` 等**经 owner 服务进 interpret bag**，不改变「判定输入」地位，
只改变来源（从世界投影改为 owner 服务）。

## 方法语义

- 写方法（`commit` / `new_conversation` / `select` / `rename` / `set_title` / `delete` / `restore` / `branch` / `deliver`）
  一律**即时写自有存储**（边跑边追加），返回**纯值**（无 `$directives`）；槽驱动方法成功后经反向调用清本线程槽。
- `read({conversation?})` → 会话切片 `{version,current,conversations,head,refs,data_gen:null,pending_turns}`：
  `refs` = 本会话消息 `id → body`（服务自建，非世界投影闭包）；`head` = 链头消息 id；`data_gen` 恒 `null`（无世界数据世代）。
- `history({conversation?,before?,limit?})` → `{conversation,messages,next_before:null,body,refs}`；
  `messages` 为**新 → 旧**窗口（`before` 命中的那条不含）。

### `commit`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `thread_id` | string，可缺 | 本线程键；缺省 `_main` |
| `slot` | object，可缺 | 本线程槽体；缺省取 `slots.slots[thread_id]`。`kind` 必须为 `chat.message` |
| `slots` | object，可缺 | 兼容入参（轮首整份输入 body）；清槽已归 `input` 服务，本服务只读取本线程槽 |
| `session` | object，可缺 | 兼容入参（旧世界 body）；**已忽略**，会话状态读自有存储 |
| `conversation` | string，可缺 | 目标会话；缺省存储 `current` |
| `new_conversation` | object，可缺 | 无当前会话时的自动建会话规格 `{id, workspace_id, title?}` |
| `user` / `assistant` | object | 消息内容（`content` / `parts` / `attachments` / `meta`） |
| `error` | string，可缺 | 失败路径：追加独立 system 消息（`meta.error`） |
| `status` / `last_seen` | 可缺 | 写回会话 `status` / `inbox.last_seen` |
| `append` | bool，可缺 | 续跑追加：只追加助手 / 系统消息（用户消息已落账） |

返回 `{ok:true, reply, conversation, count}` 或 `{ok:false, error, conversation}`；事件不变
（`thread.opened` / `thread.updated` / `thread.closed` / `workflow.step` / `group.message`）。

## 边界

- **展示与组装分离**：消息是全量、追加、独立留存的展示真源；上下文组装是只读派生视图，永不回写。
- **单 owner**：本身份独占写自己的 ④ 目录；别人经能力调用问它，不借世界当共享内存。
- **存量不搬**：新存储从空开始，旧世界世代留在链上但不再被读。
- 服务**不 import 宿主与内核**，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 计划落账 E2E（pack → seed → start → commit → run → stop → verify/replay）
```
