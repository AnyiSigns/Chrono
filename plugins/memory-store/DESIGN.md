# #21 `memory-store`（长期记忆本体）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 21 / `memory-store` |
| 职责 | 长期记忆本体：条目（文本）进世界（各自成 def + **链式 `tail`**）；**向量索引住宿主侧 ③（可重算）** |
| 依赖 | `->` 20（pins：算向量建索引 / 重建）；`<-` 22、23（投影读 / 计划写回）、27（记忆工具：agent 显式保存经 #27 派发到本插件 `put`） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["memory"]`，`methods: {memory:["put","read","search"]}`（**#23 维护类用独立能力类 `memory-maintenance`**，避免同名端口冲突） |
| 命令 | 无 |
| schema | `schema/memory.json`（条目形状 + 索引 + 模型版本锚；**向量本体不在世界**） |
| 机制 | 见下「数据契约 / 索引 / 读写 / 重建」 |
| 边界 | 不做：检索策略（归 22）/ 压缩（归 19）/ 遗忘决策（归 23）/ 向量计算（归 20）/ 直接写链 |
| 验收 | 1) 条目形状固定、可回放；2) 向量索引不进世界、可重建；3) 空库装配正常；4) `search` 暴力余弦确定；5) 换存储实现不改 22 / 23；6) 索引与条目一致（重建后同结果）；7) agent 显式保存（`put`）与 #23 固化两条来源都经写计划、可回放 |
| 状态 | 细节设计（2026-09-19，向量索引宿主侧 ③）；L3 来源 = agent 显式保存 + #23 固化（已定） |

> 写入一律经写计划落账（服务无写通道）：**agent 显式保存**经记忆工具调本插件 `put`（返回计划）；**#23 `consolidate` / `sweep`** 出固化 / 删除计划。本插件只读投影 + 维护宿主侧 ③ 索引。`21` 的写入者（agent 保存 / 23）都必须 `+ 21` 读投影才能构造计划。

## 数据契约 `schema/memory.json`

```jsonc
// 世界 body（小、可回放）：只存链尾 + 计数（**不列全部条目哈希**，避免 O(N²) 重写；同 #11 链式模式）
{ "tail": { "def": "<最新条目 def 哈希>" } | null,
  "count": 0,
  "model": { "id": "granite-97m", "dim": 384 } }   // 索引版本锚（仅记录；向量在 ③）

// 条目 def（各自成 def、内容寻址；**两级：entry 含 chunks**；prev 成链）
{ "id": "m-…", "text": "…",
  "meta": { "source": "session|skill|manual|consolidate", "workspace": "…", "session": "…", "at": "…", "tags": ["…"] },
  "chunks": [ { "index": 0, "start": 0, "end": 512 } ],   // **只存偏移，不重复存文本**（文本由 `text` 切片派生；世界只增不减，避免双份膨胀）
  "prev": { "def": "<上一条目哈希>" } | null }
```

- 条目各自成 def + **链式 `tail`** ⇒ 加一条 = 1 条目 def + 1 小 body def，**不重写全量**（同 #11；原「哈希列表」会随条目数 O(N) 重写）。
- **偏移口径**：`chunks[].start` / `end` 按 **Unicode 码点**计（与 `docs/plugins.md` §二「命令 `argsSchema` 方言」的 `minLength` / `maxLength` 同口径）；chunk 文本 = `text.slice(start,end)`，世界不落第二份。`#20 embedding.chunk` **同步返回码点偏移**（切窗用 token 计数，但输出 `start` / `end` 一律换算成码点），两插件口径统一。
- 条目 body 由**宿主投影引用闭包解析**放进 `ids.memory-store.refs`（标记 `{"def":hash}`，H1 已落地）；`read` / `search` 按 hash 从 `refs` 取条目。
- `model.{id,dim}` 是**索引版本锚**：向量本体在 ③，换模型后 ③ 重建，世界只改锚。

## 向量索引（宿主侧 ③，可重算）

- 位置：宿主**新增能力——插件 ③ 目录**（如 `state/plugins/<id>/`）；本插件索引落 `state/plugins/memory-store/index-<model>-<dim>.bin`（宿主侧可重算、可统一 GC）。
- 内容：`Float32Array`（chunk 向量，L2 已归一）+ chunk -> `{entry_hash, chunk_index}` 表。
- 可重算：任何时刻可由「世界条目 + #20 embed」重建，重建结果确定；**索引丢失不砖化**。
- 检索：`search(query_vector, top_k)` = 暴力余弦（dim 384 归一 ⇒ 点积），**用大小为 k 的最小堆做部分选择 O(N·log k)**（不全排序），返回 `[{entry_hash, chunk_index, score}]`（**chunk 级命中，由 #22 回溯 entry——即按 `entry_hash` 调本插件 `read` 取正文**）；本方法**仅供 #22 / #23 内部调用，不作 agent 工具暴露**（agent 面检索 = #22 `retrieval.search`）。

## 读写

- `read`：读投影 `ids.memory-store.body` + `ids.memory-store.refs`，按 hash 取条目。**消费方 = #22**：`retrieval.search` 拿到 `search` 的 chunk 命中后，按 `entry_hash` 调本插件 `read(entry_hash)` 取回条目正文（`read` 有明确调用者，见 #22 检索流水线第 5 步）。
- `search(query_vector, top_k)`：在 ③ 索引上暴力余弦，返回 chunk 命中；**不写世界**。
- `put`：**agent 显式保存入口**（经记忆工具派发）——读投影 + 去重（eff 20 向量）→ 返回写计划【batch：`put(条目 def)` + `put(新 body：tail 指向新条目 + count+1)` + `add_gen(21)`】；**链式 tail，不列全部条目哈希**；**不直接写**、不落账。固化来源由 #23 `consolidate` 出同类计划。

## 重建

- **增量**：`put` / `consolidate` 追加条目时，随计划落账**增量 append** 该条目各 chunk 的向量与映射（③），不重建全量；首查不再有全量重建尖峰。
- **全量重建**仅当：③ 索引缺失，或 `{model_id, dim}` 与 `schema` 锚不符 ⇒ 调 #20 全量 `chunk + embed` 重建。
- 重建期间 `search` 返回「索引构建中」结构化状态（不静默阻塞，符合「禁止静默无限等待」）。
