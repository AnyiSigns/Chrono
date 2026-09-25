# memory-consolidate（记忆维护 · 全层）

记忆维护执行件：**L1 TTL 清理** + **L2 去重合并** + **L2→L3 固化** + **L3 过期 / 遗忘 / 删除** +
**agent 顺带清理候选**。与压缩引擎（`compress`）、短期记忆（`short-memory`）、长期记忆本体（`memory-store`）分开：
本插件**经反向调用读写 owner 服务**，不读投影、不产世界写计划。

- 身份：`memory-consolidate`
- 能力类 / 方法：`memory-maintenance` → `consolidate` / `sweep` / `candidates` / `view` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`memory-maintenance.json`）
- `pins`：`compress` → `compress`（需要摘要时 eff `summarize`，`persist:false`）、`embedding` → `embedding`（去重）、
  `memory` → `memory-store`（读 `list`，写 `append` / `delete` / `pin` / `edit`）、
  `short-memory` → `short-memory`（读 `read`，写 `apply`）、`session` → `session`（读 `read` 取会话 → 工作区归属）
- 状态档：`recomputable`（sweep 水位住宿主侧 ③，可重算；不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`memory-maintenance.view`
- 运行时零 npm 依赖

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| L1 / L2 摘要各字段（owner = `short-memory`） | 运行记录（出世界） | 见 `plugins/short-memory/README.md` |
| L3 条目各字段（owner = `memory-store`） | 运行记录（出世界） | 见 `plugins/memory-store/README.md` |
| **sweep 水位** | **③ 派生物（落 `CHRONO_PLUGIN_STATE`，不进 ④）** | **可由 ④ 条目 `at` 重算 / 重扫**（判据是「删了能不能重建」）；删掉后从最早重扫，结果收敛 |
| `params.*`（schema 顶层，阈值 / 容量 / TTL） | **定义 / 判定（留世界，schema）** | 清理判定阈值；回滚应带上 |
| `periodic.*`（每拍间隔） | **定义 / 判定（留世界，schema）** | 触发调度声明 |

**结论**：本身份无自有运行记录（L1/L2/L3 归 owner 服务）；水位是 ③ 派生物；留在世界的是 schema（策略参数）。

## 边界（迁移后）

- **读写一律经 owner 服务**：`consolidate` / `sweep` / `edit` 经 `port.call` 读 `short-memory.read` /
  `memory.list` / `session.read`，算结果后经 `short-memory.apply` / `memory.append` / `memory.delete` /
  `memory.pin` / `memory.edit` 写回；**不产 `$directives`、不直接写链**。
- **不读投影**：owner 数据由服务自行读取，`schema.periodic` 不再有 `reads`。
- 不做：调模型（交 `compress`）/ L3 存储实现（交 `memory-store`）/ 向量计算（交 `embedding`）/
  判定「该不该维护」（归 `loop-policy` 准则）。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 触发

- `consolidate` / `sweep` 的周期住 `schema/memory-maintenance.json` 顶层 `periodic`（两拍：`consolidate` 1h、`sweep` 30min），
  由宿主按周期直接调服务方法；数据由服务自读，不再注入投影。
- `candidates` 经记忆工具具名工具 `memory.candidates` 暴露；`view` / `edit` 经 `ui-settings` 记忆 tab 的命令入口 term 装配 args。

## 五个方法

| 方法 | 做什么 | 写哪（经 owner 服务） |
| --- | --- | --- |
| `consolidate` | `embedding chunk + embed` → 按 entry 聚合去重；需要摘要时 eff `compress`（`persist:false`）；**L1 合并进 L2**（`sources[]` 追加来源会话 id、最新在前）；**L2 高价值项固化进 L3** | `short-memory.apply`（L2）+ `memory.append`（L3） |
| `sweep` | 选待删：**L1 过期（24h）**、L2 超容量、L3 低权重 / 超容量（跳过 `pinned`）；以水位为游标增量扫描 | `short-memory.apply`（`del_sessions` / `set_workspaces`）+ `memory.delete` |
| `candidates` | 只读：回「过期 / 低价值」候选列表，**不删** | 无（返回值） |
| `view` | 只读：回 L1 / L2 / L3 三档，含 `at` / 剩余 TTL / tags / source / `weight` / `pinned` | 无（返回值） |
| `edit` | 改 / 删 / 置顶：L3 删除 / 置顶 / 文本编辑；L1/L2 删除 / 摘要编辑（置顶不适用） | `memory.delete` / `pin` / `edit`；`short-memory.apply` |

- **冲突消解（机械）**：同键多版本取 `at` 最新（同 `at` 取来源可信度高者：历史 > L1 > L2 > L3）；语义矛盾机械不判。
- **确定性**：去重排序由 `(at 降序, 来源优先级, key 升序)` 完全决定；空集 / 空删除集**不产生写**；
  `compress` / `embedding` 不可用时回结构化错误、**不半写**（先读后算、确认成功才写）。
- **水位**：只在**无变更**（`no_changes`）时推进——此时没有会被跳过的候选。有变更时服务不推进水位，
  只回 `cursor_next`；调用方显式给 `args.cursor` 时服务不改本地水位。

## 策略参数（`schema/memory-maintenance.json` 顶层 `params`，可热改）

| 参数 | 缺省 | 含义 |
| --- | --- | --- |
| `l1_ttl_ms` | `86400000` | L1 硬 TTL（24h）；`sweep` 按 `expires_at` 或 `at + TTL` 判过期 |
| `l2_capacity` | `200` | 单工作区 L2 facts 容量上限（超出从最旧一端裁） |
| `l3_capacity` | `500` | L3 存活条目容量上限（超出按 weight / at 淘汰） |
| `dedup_cosine_threshold` | `0.9` | 去重余弦阈值（合并 / 固化） |
| `consolidate_weight_threshold` | `0.7` | 固化权重阈值（L2 项 → L3） |
| `candidate_weight_threshold` | `0.2` | 候选 / 淘汰低权重阈值 |
| `solidify_full_sources` | `4` | 固化权重推导：`min(1, sources 数 / 该值)` |

- 调用方可在 args 按次覆盖；覆盖值形态非法回 `bad_args`。

## 入参（`args`）

```jsonc
// consolidate
{ "summarize": false, "high_value": [], "item_weights": {}, "embedding_model": "granite-97m" }

// sweep
{ "cursor": "2020-01-01T00:00:00.000Z" }

// candidates / view
{}

// edit
{ "action": "delete|pin|text", "layer": "l1|l2|l3", "id": "…", "patch": { "text": "…" } }
```

- `now` 由调用帧 `env` 传入（缺省回落 args.now）；服务绝不自取时钟。

## 运行

```sh
npm test                        # 协议级 + 包形状测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
