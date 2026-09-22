# memory-consolidate（记忆维护 · 全层）

记忆维护执行件：**L1 TTL 清理** + **L2 去重合并** + **L2→L3 固化** + **L3 过期 / 遗忘 / 删除计划** +
**agent 顺带清理候选**。与压缩引擎（`compress`）、长期记忆本体（`memory-store`）分开：本插件只出**计划**，
不直接写链、不读投影。

- 身份：`memory-consolidate`
- 能力类 / 方法：`memory-maintenance` → `consolidate` / `sweep` / `candidates` / `view` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`memory-maintenance.json`）
- `pins`：`compress` → `compress`（需要摘要时 eff `summarize`）、`embedding` → `embedding`（去重 `chunk` + `embed`）、
  `memory` → `memory-store`（**身份级依赖声明，非反向调用端口**）。`compress` / `embedding` 运行期经 `port.call`
  反向调用；`memory` 不同——L3 数据（`memory_store` body + refs）由调用方入口 term 读出随 bag 传入，写入只产
  「写 `memory-store` body」的计划（`$directives`）交宿主落账，本插件**从不** `port.call memory`。保留该 pin 的
  理由：它是宿主装配期的依赖边（`memory-store` 先起、其退役 / 隔离沿依赖图传播到本插件），且 `memory-store`
  不存在时本插件无数据可维护；删掉会弱化这条装配顺序与隔离语义。
- 状态档：`recomputable`（sweep 水位住宿主侧 ③，可重算；不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`memory-maintenance.view`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 边界

- **写入一律经写计划落账（服务无写通道）**：所有方法只回 `{"$directives":[…]}`，**不直接写链**、不落账。
- **不读投影**：`short-memory` L1/L2、`session` 会话、`memory-store` body + refs 由调用方入口 term 装配或宿主按
  `schema.periodic.reads` 机械注入 bag（D8）。
- 不做：调模型（交 `compress`）/ L3 存储实现（交 `memory-store`）/ 向量计算（交 `embedding`）/
  判定「该不该维护」（归 `loop-policy` 准则）。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 触发

- `consolidate` / `sweep` 的周期住 `schema/memory-maintenance.json` 顶层 `periodic`（两拍：`consolidate` 1h、`sweep` 30min），
  由宿主按周期直接调服务方法、并按 `reads` 注入 `short-memory` / `session` / `memory-store` 投影片段；本插件不自触发。
- `candidates` 经记忆工具具名工具 `memory.candidates` 暴露（绑定在工具插件侧）；`view` / `edit` 经
  `ui-settings` S12 记忆 tab 的命令入口 term 装配 args。

## 三个以上方法

| 方法 | 做什么 | 写哪 |
| --- | --- | --- |
| `consolidate` | `embedding chunk + embed` → 按 entry 聚合去重（余弦阈值）→ 需要摘要时 eff `compress`；**L1 合并进 L2**（`sources[]` 追加来源会话 id、最新在前）；**L2 高价值项固化进 L3** | 计划【batch：写 `short-memory` L2 + 写 `memory-store` L3】 |
| `sweep` | 选待删：**L1 过期（24h）**、L2 超容量、L3 低权重 / 超容量（跳过 `pinned`）；以「上次 sweep 水位」为游标增量扫描 | 计划【batch：写 `short-memory` + 写 `memory-store`（**删除 L3 = `memory-store` body 加 `deleted` 条目**）】 |
| `candidates` | 只读：回「过期 / 低价值」候选列表，**不删** | 无（返回值） |
| `view` | 只读：回 L1（`short-memory`）/ L2（`short-memory`）/ L3（`memory-store` 元数据）三档，含 `at` / 剩余 TTL / tags / source / `weight` / `pinned` | 无（返回值） |
| `edit` | 改 / 删 / 置顶：**删除 = `memory-store` body `deleted`；置顶 = `body.pinned`；文本编辑 = put 新条目 def + 新 body** | 计划【batch：写 `short-memory` L1/L2 + 写 `memory-store` L3】 |

- **冲突消解（机械）**：同键多版本取 `at` 最新（同 `at` 取来源可信度高者：历史 > L1 > L2 > L3）；
  语义矛盾机械不判，交 agent 按准则修正。
- **确定性**：去重排序由 `(at 降序, 来源优先级, key 升序)` 完全决定；空集 / 空删除集**不产生写**
  （只回 `extern`）；`compress` / `embedding` 不可用时回结构化错误、**不半写**。
- **水位与落账**：水位只在**无待落账删除**（`no_changes`）时推进——此时没有会被跳过的候选。有删除时
  服务不推进水位，只回 `cursor_next`，由调用方在计划落账后自行持久化；故计划未落账时同输入重跑
  **仍产出同一删除集**。调用方显式给 `args.cursor` 时服务不改本地水位（游标完全由调用方控制）。

## 策略参数（`schema/memory-maintenance.json` 顶层 `params`，可热改）

| 参数 | 缺省 | 含义 |
| --- | --- | --- |
| `l1_ttl_ms` | `86400000` | L1 硬 TTL（24h）；`sweep` 按 `expires_at` 或 `at + TTL` 判过期 |
| `l2_capacity` | `200` | 单工作区 L2 facts 容量上限（超出由 `sweep` 从最旧一端裁） |
| `l3_capacity` | `500` | L3 存活条目容量上限（超出由 `sweep` 按 weight / at 淘汰） |
| `dedup_cosine_threshold` | `0.9` | 去重余弦阈值（`consolidate` 合并 / 固化） |
| `consolidate_weight_threshold` | `0.7` | 固化权重阈值（L2 项 → L3） |
| `candidate_weight_threshold` | `0.2` | 候选 / 淘汰低权重阈值 |
| `solidify_full_sources` | `4` | 固化权重推导：`min(1, sources 数 / 该值)` |

- 调用方可在 args 按次覆盖（`l1_ttl_ms` / `l2_capacity` / `l3_capacity` / `dedup_threshold` /
  `weight_threshold` / `candidate_threshold` / `solidify_full_sources`）；覆盖值形态非法回 `bad_args`。

## 入参（`args` / bag）

```jsonc
// consolidate
{ "short_memory": {}, "session": {}, "memory_store": {}, "memory_store_refs": {},
  "summarize": false, "high_value": [], "item_weights": {}, "embedding_model": "granite-97m" }

// sweep
{ "short_memory": {}, "memory_store": {}, "memory_store_refs": {}, "cursor": "2020-01-01T00:00:00.000Z" }

// candidates / view
{ "short_memory": {}, "memory_store": {}, "memory_store_refs": {} }

// edit
{ "action": "delete|pin|text", "layer": "l1|l2|l3", "id": "…", "patch": { "text": "…" },
  "short_memory": {}, "memory_store": {}, "memory_store_refs": {} }
```

- `now` 由调用帧 `env` 传入（缺省回落 args.now）；服务绝不自取时钟。
- 删除 L3 = 新 `memory-store` body 加 `deleted[id] = at`（链上 def 不动，读取方按 `body.deleted` 过滤）；
  置顶 = `body.pinned[id] = true`（淘汰时跳过，不改 `at`）；文本编辑 = put 新条目 def（同 id）+ 新 body 指向。

## 运行

```sh
npm test                        # 协议级 + 包形状测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（pack 依赖链 → seed → 离线投影 + 协议直连假后端）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
