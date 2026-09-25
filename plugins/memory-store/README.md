# memory-store（长期记忆本体 · L3）

长期记忆本体：条目（文本）经**链式 `tail` → `prev`**（按条目 id）串联。条目与 body 是**运行记录**，
已**出世界**：住本服务自有持久存储（④ `CHRONO_PLUGIN_DATA/memory.jsonl`，追加日志）。
**向量索引住 ③（`CHRONO_PLUGIN_STATE`，可重算）**，删掉可由 ④ 重建。来源 = agent 显式保存（`put`）+
记忆维护固化（`append`）。

- 身份：`memory-store`
- 能力类 / 方法：`memory` → `put` / `read` / `search` / `list` / `append` / `delete` / `pin` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`memory.json`）
- `pins`：`embedding` → `embedding`（建 / 重建索引与 `put` 去重，调 `embedding.chunk` + `embedding.embed`）
- 状态档：`durable`（④ 不可重算）；`exclusive: ["data"]`
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`memory.search`
- 运行时零 npm 依赖

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `body.tail` / `body.count` / `body.deleted` / `body.pinned` | 运行记录（出世界） | 链尾 / 计数 / 逻辑删除 / 置顶都是运行态；回滚不该带 |
| `body.model.{id,dim}` | 运行记录（出世界） | 索引版本锚；判定经服务读，不从世界读 |
| `entry.id` / `entry.text` / `entry.meta.*` / `entry.weight` | 运行记录（出世界） | 条目本体即运行记录 |
| `entry.chunks[].{index,start,end}` | 运行记录（出世界） | 文本偏移属运行数据；文本由 `text` 切片派生 |
| `entry.prev` | 运行记录（出世界） | 链指针属运行数据 |
| **向量索引（records / 向量本体）** | **③ 派生物（落 `CHRONO_PLUGIN_STATE`，不进 ④）** | **删了能由 ④ 条目重算**（判据是「删了能不能重建」，不是「大不大」）；索引不是运行记录本体 |
| `model`（schema 顶层 `{id,dim}`） | **定义 / 判定（留世界，schema）** | 换模型判定与索引锚；回滚应带上 |
| `method_timeouts` / 参数默认值 | **定义 / 判定（留世界，schema）** | 执行门禁 |

**结论**：条目与 body 全部出世界（④）；向量索引是 ③ 派生物，**不得混进 ④**；留在世界的是 schema（数据契约 def）。

## 数据契约（`schema/memory.json`）

```jsonc
// ④ 存储内 body（由追加日志重放得到）：链尾 + 计数 + 逻辑删除 / 置顶 + 索引锚
{ "tail": { "def": "<最新条目 id>" } | null,
  "count": 0,
  "deleted": { "<条目 id>": "<删除时间 at>" },
  "pinned": { "<条目 id>": true },
  "model": { "id": "granite-97m", "dim": 384 } }

// 条目（按 id 覆盖；chunks 只存偏移，文本由 text 切片派生；prev 成链）
{ "id": "m-…", "text": "…",
  "meta": { "source": "session|skill|manual|consolidate", "workspace": "…", "session": "…", "at": "…", "tags": ["…"] },
  "weight": 0.5,
  "chunks": [ { "index": 0, "start": 0, "end": 512 } ],
  "prev": { "def": "<上一条目 id>" } | null }
```

- **删除 / 置顶**：`deleted` / `pinned` 集合住 body（条目不动）；**读取方必须按 `body.deleted` 过滤**
  （写死为契约，本插件的 `read` / `search` / `list` 同样遵守）。
- `chunks[].start` / `end` 按 **Unicode 码点**计（与 `embedding.chunk` 同口径）；chunk 文本 = `text.slice(start,end)`，不落第二份。
- `model.{id,dim}` 是**索引版本锚**：向量本体在 ③，换模型后 ③ 重建。

## 存储引擎与落点（④）

- `CHRONO_PLUGIN_DATA/memory.jsonl`：单文件追加日志，每条一次 append + fsync（换行收尾）；启动重放即得全量状态。
- 记录：`{t:'entry', run, entry}`（同 id 覆盖，幂等）、`{t:'body', run, body}`、`{t:'turn', run, state:'open'|'closed'}`。
- **边跑边追加**：`put` / `append` / `edit` 先置回合 `open`、再落记录、再置 `closed`；中途崩留下的 `open` 标记即中断残留。
- **幂等**：同 id 同内容短路；同回合重复写同值幂等。**存量不搬**：存储从空开始。

## 八个方法

| 方法 | 做什么 | 回什么 |
| --- | --- | --- |
| `put` | agent 显式保存：向量化 `chunk + embed` → 与现有条目向量去重 → 写自有存储 | `{ok:true,kind:'put',saved:true,id,count,chunks,dedup:'vector',model}`；重复回 `{saved:false,duplicate:true,duplicate_of}`；后端不可用回结构化错误、不半写 |
| `read` | 按 `hash` / `hashes`（= 条目 id）取条目；`deleted` 回 `null` | `{ok:true,kind:'read',…}`；消费方 = 检索插件 |
| `search` | 在 ③ 索引上暴力余弦（归一 ⇒ 点积），最小堆部分选择 O(N·log k) | `{ok:true,kind:'search',status:'ready',hits:[{entry_hash,chunk_index,score}]}`；索引未就绪回 `status:'index_building'` |
| `list` | 回存活条目（新→旧）+ `count` + `pinned` | `{ok:true,kind:'list',entries:[{id,text,meta,weight}],count,pinned}` |
| `append` | 批量追加条目（记忆维护固化用）：各自 `chunk + embed` 后写自有存储、增量入索引 | `{ok:true,kind:'append',added,count}` |
| `delete` | 逻辑删除（body.deleted） | `{ok:true,kind:'delete',deleted}` |
| `pin` | 置顶 / 取消置顶（body.pinned） | `{ok:true,kind:'pin',id,pinned}` |
| `edit` | 同 id 覆盖条目（保留链位置），重算 chunks / 向量并替换索引记录 | `{ok:true,kind:'edit',id,text}` |

- `search` 仅供检索 / 记忆维护内部调用，**不对 agent 暴露**；`read` 经记忆工具绑定暴露为 `memory.read`。
- `put` 的 `meta.source`：agent 显式保存 = `manual`；记忆维护固化 = `consolidate`。

## 索引（宿主侧 ③，可重算）

- 位置：`CHRONO_PLUGIN_STATE/index-<model>-<dim>.bin`（宿主起服务时注入本身份 ③ 目录；env 缺失则索引只驻内存）。
- 格式（小端二进制）：`magic "CMSIDX01" / version / dim / count / modelId / recordCount / records`；
  每条记录 = `{entryId / chunkIndex / dim×float32}`。向量已 L2 归一。
- **③/④ 分界**：删掉整个 ③ 目录后，服务仍从 ④ 条目全量重建索引并正常应答（见 `test/service.test.mjs`）。
- **增量 append**：`put` / `append` / `edit` 增量维护；**全量重建**：③ 缺失 / 损坏、锚不符、或 `index.count < body.count`。
- 重建期间 `search` 回「索引构建中」结构化状态，下次查询即用新索引；重建结果确定。

## 入参（`args`）

```jsonc
// put
{ "text": "…", "meta": { "source": "manual", "workspace": "…", "session": "…", "at": "…", "tags": [] },
  "weight": 0.5, "id": "m-…", "dedup_threshold": 0.95 }

// read
{ "hash": "…" }                                  // 或 "hashes": ["…"]

// search
{ "query_vector": [/* dim 个 float */], "top_k": 10, "rebuild": false }

// append
{ "entries": [ { "id": "m-…", "text": "…", "meta": {}, "weight": 0.5 } ] }

// delete / pin / edit
{ "ids": ["m-…"], "at": "…" } / { "id": "m-…", "pinned": true } / { "id": "m-…", "text": "…" }
```

- 形态非法 → 结构化 `bad_args`；`query_vector` 维度与锚不符 → `dim_mismatch`。
- `id` 缺省由 `at` + 文本确定性派生（FNV-1a 业务 id）；`dedup_threshold` 缺省 0.95。

## 清理责任（owner 退役）

自写存储：owner 退役时宿主按身份回收删除 `state/data/memory-store/`；向量索引随 ③ 一并回收。无需额外清理方法。

## 运行

```sh
npm test                        # 协议级 + 逻辑级 + 包形状测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
