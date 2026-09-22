# memory-store（长期记忆本体 · L3）

长期记忆本体：条目（文本）各自成 def、经**链式 `tail`** 串联（body 只存链尾 + 计数，不列全部条目哈希）；
**向量索引住宿主侧 ③（可重算）**，不随世界落账。来源 = agent 显式保存（`put`）+ 记忆维护固化（`consolidate`）。

- 身份：`memory-store`
- 能力类 / 方法：`memory` → `put` / `read` / `search`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`memory.json`）
- `pins`：`embedding` → `embedding`（建 / 重建索引与 `put` 去重，调 `embedding.chunk` + `embedding.embed`）
- 状态档：`recomputable`（向量索引可重算、可统一 GC；不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`memory.search`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 边界

- **写入一律经写计划落账（服务无写通道）**：`put` 回去重后的写计划，**不直接写链**、不落账。
- **不读投影**：`body` + `refs` 由调用方入口 term 读出随 `args` 传入（本插件自身无 `+`）。
- 不做：检索策略（归检索插件）/ 压缩（归压缩引擎）/ 遗忘决策（归记忆维护）/ 向量计算（归向量化服务）。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 数据契约（`schema/memory.json`）

```jsonc
// 世界 body（小、可回放）：只存链尾 + 计数，避免 O(N²) 全量重写
{ "tail": { "def": "<最新条目 def 哈希>" } | null,
  "count": 0,
  "deleted": { "<条目 id>": "<删除时间 at>" },
  "pinned": { "<条目 id>": true },
  "model": { "id": "granite-97m", "dim": 384 } }

// 条目 def（各自成 def、内容寻址；两级：entry 含 chunks；prev 成链）
{ "id": "m-…", "text": "…",
  "meta": { "source": "session|skill|manual|consolidate", "workspace": "…", "session": "…", "at": "…", "tags": ["…"] },
  "weight": 0.5,
  "chunks": [ { "index": 0, "start": 0, "end": 512 } ],
  "prev": { "def": "<上一条目哈希>" } | null }
```

- 加一条 = 1 条目 def + 1 小 body def，**不重写全量**。
- **删除 / 置顶**：`deleted` / `pinned` 集合住 body（链上 def 不动）；**读取方必须按 `body.deleted` 过滤**（写死为契约，
  本插件的 `read` / `search` 同样遵守）。文本编辑 = put 新条目 def + 新 body 指向。
- `chunks[].start` / `end` 按 **Unicode 码点**计（与向量化服务 `embedding.chunk` 输出同口径）；chunk 文本 = `text.slice(start,end)`，
  世界不落第二份。
- `model.{id,dim}` 是**索引版本锚**：向量本体在 ③，换模型后 ③ 重建，世界只改锚。

## 三个方法

| 方法 | 做什么 | 回什么 |
| --- | --- | --- |
| `put` | agent 显式保存：向量化服务 `chunk + embed` → 与现有条目向量去重 → **回写计划** | `batch【put(条目 def) + put(新 body：tail 指向新条目、count+1) + add_gen】`；重复回只含 `extern` 的计划（`saved:false`、`duplicate_of`）；后端不可用回结构化错误、不半写 |
| `read` | 按传入 `refs` 取条目（`hash` 单条 / `hashes` 批量）；`deleted` 条目回 `null` | `{ok:true,kind:'read',…}`；消费方 = 检索插件（按 `search` 的 `entry_hash` 取正文） |
| `search` | 在 ③ 索引上暴力余弦（dim 384 归一 ⇒ 点积），**大小为 k 的最小堆做部分选择 O(N·log k)** | `{ok:true,kind:'search',status:'ready',hits:[{entry_hash,chunk_index,score}]}`；索引未就绪回 `status:'index_building'`（不静默阻塞） |

- `search` 仅供检索 / 记忆维护内部调用，**不对 agent 暴露**（agent 面检索 = 检索插件的 `retrieval.search`）；
  `read` 经记忆工具绑定暴露为 `memory.read`。
- `put` 的 `meta.source`：agent 显式保存 = `manual`；记忆维护固化 = `consolidate`。

## 索引（宿主侧 ③，可重算）

- 位置：`CHRONO_PLUGIN_STATE/index-<model>-<dim>.bin`（宿主起服务时注入本身份 ③ 目录；env 缺失则索引只驻内存）。
- 格式（小端二进制）：`magic "CMSIDX01" / version / dim / count / modelId / recordCount / records`；
  每条记录 = `{entryId(32B 定长) / chunkIndex / dim×float32}`。向量已 L2 归一。
- **记录存条目逻辑 id 而非 def 哈希**：`put` 时新条目 def 哈希是批内占位符（由内核替换），服务算不出；
  查询时经传入 `refs` 的 id → hash 解析出 `entry_hash`，并顺带完成 `deleted` / 未落账过滤。
- **增量 append**：`put` 追加该条目各 chunk 的向量与映射，不重建全量。
- **全量重建**：③ 索引缺失 / 损坏、`{model_id,dim}` 与 schema 锚不符、或 `index.count < body.count`（索引落后，
  如其它写者直接加条目）⇒ 调向量化服务全量 `chunk + embed` 重建；`search` 可带 `rebuild:true` 强制重建。
- 重建期间 `search` 回「索引构建中」结构化状态，下次查询即用新索引；重建结果确定，与增量结果一致（验收 6）。

## 入参（`args` / bag）

```jsonc
// put
{ "text": "…", "body": { /* memory-store 整份 body */ }, "refs": { /* 闭包 hash → 条目 def */ },
  "meta": { "source": "manual", "workspace": "…", "session": "…", "at": "…", "tags": [] },
  "weight": 0.5, "id": "m-…", "dedup_threshold": 0.95 }

// read
{ "body": {}, "refs": {}, "hash": "…" }        // 或 "hashes": ["…"]

// search
{ "query_vector": [/* dim 个 float */], "top_k": 10, "body": {}, "refs": {}, "rebuild": false }
```

- 形态非法 → 结构化 `bad_args`；`query_vector` 维度与锚不符 → `dim_mismatch`。
- `id` 缺省由 `at` + 文本确定性派生（FNV-1a 业务 id，非内核哈希）；`dedup_threshold` 缺省 0.95。

## 运行

```sh
npm test                        # 协议级 + 逻辑级 + 包形状测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（pack 依赖链 → seed → 离线投影 + 协议直连假后端）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
