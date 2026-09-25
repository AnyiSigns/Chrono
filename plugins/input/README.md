# input（输入槽运行记录 + 服务）

用户意图信箱：**per-thread 键控寄存器**。槽是**运行记录**，住**服务自有持久存储**（④ `CHRONO_PLUGIN_DATA`），
**不进世界**——不产 `write` directive、不占 `seq`、不改 `worldRev`。客户端经命令写槽、回合经命令读槽。

- 身份：`input`；能力类：`input`；方法：`read` / `write` / `clear`。
- 命令：`input.read`（只读，纯查询）、`input.write`（写本线程槽）。
- `pins`：无；状态档：`durable`（④）；`exclusive: ["data"]`。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 存储引擎与落点

- ④ `CHRONO_PLUGIN_DATA/slots.jsonl`：单文件追加日志，每条记录一次 append + fsync；启动重放即得全量槽位。
  记录 `{t:'slot', run, thread, slot}`：同线程后写覆盖前值；**同值不重写**（幂等短路）。
- ③ `CHRONO_PLUGIN_STATE/index.json`：派生物（记录水位 / 线程数），删掉可由 ④ 重放重建。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。

body 形状 `{ slots: { "<thread_id>": <槽 body> } }`：

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `slots`（整表） | 运行记录（出世界） | 用户意图信箱是回合输入态；回滚不该带；判定（消费槽跑管道）经命令读 owner，不从世界投影读 |
| `slots[<thread>]`（槽 body，含 `kind` / `text` / `attachments` / `conversation` / `title` / `message` / `id` / `verdict` / `answers` / `action` / `layer` / `patch` 等） | 运行记录 | 槽是待消费的用户意图，消费后即清；无字段属定义 / 判定 |
| `idle`（槽 kind） | 运行记录 | 清槽标记 |

**结论**：输入槽**无留在世界的定义字段**；留在世界的是 `Identity.schema`（`schema/slot.schema.json` 数据契约 def）。

## 方法 / 命令

- `read({thread?})` → `{slots:{…}}`；给 `thread` 时另附 `{thread, slot}`。
- `write({thread?, slot})` → 覆盖本线程槽，回 `{ok:true, thread}`；`slot` 必填。
- `clear({thread?, thread_id?})` → 本线程槽置 `{kind:'idle'}`，其余线程键不动。
- 线程键缺省取帧 `env.thread`，再缺省 `_main`。

## 写入与清槽

- 写 = `input.write` 命令（浏览器 / 侧栏调用）；服务按 `env.emitter`（宿主填）单 owner 写自有存储。
- 清槽 = `session.commit` 等消费方在提交后经反向调用 `input.clear`；也可由写入端显式调用。
- 不擦其他线程键。

## 状态档

`state: "durable"`（④ 不可重算）；`exclusive: ["data"]`（单写句柄）。

## `.worldignore`

声明 `test/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `execute/` / `terms/` / `schema/`）随源码入世。
