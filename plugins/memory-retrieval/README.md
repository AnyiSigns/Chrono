# memory-retrieval（记忆检索 · L3 召回）

L3 长期记忆的**召回服务**（Rust）：构造查询 → 向量化 → 索引检索 → 过滤 → 时间衰减 → 去重 → MMR
（+ 可选语义重排）→ 按预算截断，结果写入 `bag.recall`。纯计算 + 反向调用，**无写通道、不读投影、不取时间**；
模型项（多查询 / 语义重排）默认关，关闭时同输入同输出、逐字节可回放。

- 身份：`memory-retrieval`
- 能力类 / 方法：`retrieval` → `search`
- 命令：无
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`retrieval.json`）
- pins：`embedding`（查询 / 候选向量化）、`memory`（索引检索 + 按 hash 取正文）、`model`（多查询 / 语义重排，可关）
- 状态档：`recomputable`（③ 查询向量缓存丢失只影响一次重算）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`retrieval.search`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- **不做**：写入（归 `memory-store`）/ 压缩（归 `compress`）/ 向量化实现（归 `embedding`）/ 存储与索引实现（归 `memory-store`）/
  上下文组装（归 `context-window`）/ 直接写世界。
- 服务不 import 宿主与内核；跨插件只走反向调用 `port.call`。
- 无写通道：结果只是返回值（`bag.recall`），不产 `$directives`。

## 检索流水线

```
1 查询构造   双入口：顶层 query（recall 节点路径 / 记忆工具路径）；拼上 L1 goal
2 多查询     （开关，默认关）eff model.chat 生成 2–3 个子查询
3 向量化     每查询 eff embedding.embed（③ 查询向量缓存命中即用）
4 索引检索   每查询 eff memory.search(query_vector, top_k)
5 归并       按 chunk 取跨查询最高分；chunk → entry 回溯，eff memory.read(hashes) 取正文
6 过滤       工作区范围（默认开）+ 标签 / 来源
7 时间衰减   score × exp(-λ · age)，age 由 bag 时间 − meta.at 算（服务不取时间）
8 阈值       衰减后低于余弦阈值者丢弃（先衰减再卡阈值）
9 去重       同 entry 取最高分；与 bag.dedup_set 预去重
10 重排      MMR（多样性）；（开关，默认关）eff model.chat listwise 语义重排
11 预算截断  按 bag.recall_budget 定最终条数，写入 bag.recall
```

## 方法契约

### `search(bag) -> { ok, kind, status, model, query, queries, recall, count, budget, stats }`

**bag 键形状**（服务不读投影；以下数据由调用方入口 term 读出随 bag 传入）：

| bag 键 | 形状 | 说明 |
| --- | --- | --- |
| `query` | string | 查询文本（双入口在入口 term 侧区分，服务侧同形）。 |
| `goal` | string | 本会话 L1 goal / 摘要，拼进查询；也接受 `bag.l1.goal`。 |
| `workspace` | string | 当前工作区 id；工作区范围过滤据此判定。 |
| `memory` | `{ body, refs }` | **`memory-store` 身份投影**：`body` = 身份 body（链尾 + 计数 + `deleted` / `pinned` + 模型锚），`refs` = 引用闭包 `{<条目 def 哈希>: <条目 body>}`。本服务原样转发给 `memory.search` / `memory.read`。也接受 `memory_body` / `memory_refs` 或顶层 `body` / `refs`。 |
| `retrieval` | object | 召回策略配置（可热改）；也接受 `options` 别名。 |
| `recall_budget` | integer | 召回预算（由 `loop-policy` 按 `thresholds` 写入）；优先于 `retrieval.recall_budget`。 |
| `dedup_set` | string[] | 在上下文条目的 `dedup_key` 列表（与上下文调配器同口径）。 |
| `now` | number \| string | 宿主固定时钟（epoch 毫秒或 ISO 8601）；缺省回落调用帧 `env.now`。 |
| `model_config` | object | 多查询 / 语义重排时 `model.chat` 的连接实例；缺失时模型项降级为关闭。 |

**`retrieval` 配置**（缺省见 `schema/retrieval.json` 顶层 `defaults`）：

| 键 | 缺省 | 含义 |
| --- | --- | --- |
| `top_k` | 8 | 最终注入条目数上限（与预算取小）。 |
| `recall_budget` | — | 召回预算；顶层 `bag.recall_budget` 优先。 |
| `min_score` | 0.0 | 余弦阈值：衰减后低于此值丢弃。 |
| `decay_lambda` | 0.0 | 时间衰减 λ；0 = 不衰减。 |
| `workspace_scope` | true | 工作区范围过滤开关（当前工作区 + 全局条目）。 |
| `tags` | [] | 非空时保留 `meta.tags` 与之相交的条目。 |
| `source` | [] | 非空时保留 `meta.source` 命中的条目。 |
| `mmr_lambda` | 0.7 | MMR 相关度 / 多样性权衡；1.0 = 纯相关度。 |
| `rerank` | false | 语义重排开关（eff `model.chat`）。 |
| `multi_query` | false | 多查询开关（eff `model.chat`）。 |
| `model` | granite-97m | 向量模型 id。 |
| `dim` | 384 | 向量维度。 |

**返回**：`recall` 是召回条目数组（`{entry_hash, entry_id, chunk_index, score, score_raw, text, meta}`），
即写入 `bag.recall` 的内容；`count` = 条数，`budget` = 生效上限，`stats` = 各阶段丢弃计数。
空库 / 无命中回 `recall: []`、`ok: true`，不报错；依赖调用失败回 `{ok:false, error:{code,message}}`。

### 查询向量缓存（③）

查询 / 候选文本向量按 `hash(model + "\n" + text)` 缓存于 `state/plugins/memory-retrieval/query-vectors.json`
（`CHRONO_PLUGIN_STATE` 注入）。缓存缺失 / 损坏按未命中处理，重新调用 `embedding.embed`；缓存丢失不影响正确性
（向量化确定，命中与未命中输出逐字节一致）。

### dedup_key 规范化（与上下文调配器同口径）

`dedup_key(text)` = 去首尾空白 → 空白折叠为单空格 → 转小写。调用方以同口径算出在上下文条目的 `dedup_key`
放入 `bag.dedup_set`；本服务据此做**尽力预去重**（最终组装视图由上下文调配器在召回之后形成，它仍会做最后一道去重）。

### 时间与衰减

`age` 一律由传入时间算：`meta.at`（ISO 8601 或 epoch 毫秒）与 `now`（`bag.now` 优先，回落 `env.now`）。
`score × exp(-λ · age_seconds)`；`at` 不可解析 / 在未来 / λ ≤ 0 时衰减因子回 1（fail-open）。服务**不自取时间**。

## 与调用方的关系

- `loop-policy` 的 `recall` 节点（图版本插入后）与记忆工具路径 eff 本服务 `search`，bag 带当前轮文本 / 工作区 / 预算 /
  `memory-store` 投影；召回先于组装，结果写入 `bag.recall` 供上下文调配器读取（调配器不 eff 本服务）。
- 语义重排 / 多查询打开时，该次召回的模型输出不参与重放（已知限制，与 `model-protocol` 同口径）。

## 测试与 E2E

```sh
npm test                     # 等价 cargo test：纯函数单测（余弦 / MMR / 衰减 / 阈值 / 预算 / 去重）
                             # + 集成 test/integration.rs（黑盒经协议驱动真实二进制，线协议桥接注入假 embedding / memory / model）
node tools/e2e-smoke.mjs     # 离线入世 E2E：按 pins 拓扑序 pack + seed + 读世界验证声明 / pins 解析 / .worldignore（不跑 cargo）
```

集成测试覆盖：命中集确定、空库、同条目多块不重复、工作区 / 来源 / 标签过滤、预算截断、与 `dedup_set` 去重、
阈值（先衰减再卡阈值）、读取失败降级为空、不产生写。

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界；
`plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` / `src/` / `schema/` 随源码入世。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde_json` crates）；缓存就位后离线可复现。
- **多查询 / 语义重排**依赖 `bag.model_config`（连接实例）；缺失时降级为关闭，不报错。模型输出不参与重放。
- **候选 MMR 向量化**需要额外一次 `embedding.embed`；失败即降级为分数序（不报错）。
- **`memory.read` 失败**按未命中处理（降级为空召回），不阻塞组装。
