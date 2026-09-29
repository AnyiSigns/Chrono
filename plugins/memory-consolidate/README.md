# memory-consolidate（记忆维护 · 全层门面）

记忆维护的**时序编排门面**：保留能力类 `memory-maintenance` 的公开方法面
（`consolidate` / `sweep` / `candidates` / `view` / `edit`）与返回形状，按 layer 把算法委派给三个提供方：

- `l1-maintenance`：L1 TTL 24h 清理 / 过期候选 / L1 视图
- `l2-maintenance`：L1→L2 分组合并去重 / L2 超容量裁剪 / L2 视图与编辑
- `l3-maintenance`：L2 高价值项固化 / L3 低权重·超容量遗忘 / L3 视图与编辑

本服务**经反向调用**三个提供方，自身不直接读写 owner 服务、不读投影、不产世界写计划、不自取时钟。

- 身份：`memory-consolidate`
- 能力类 / 方法：`memory-maintenance` → `consolidate` / `sweep` / `candidates` / `view` / `edit`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`memory-maintenance.json`）
- `needs`：`l1-maintenance` / `l2-maintenance` / `l3-maintenance`（各 `one`）
- 状态档：`recomputable`（不取时间 / 随机，同输入同输出）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## 编排归口

| 方法          | 编排                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `consolidate` | 先 `l2-maintenance.merge`（L1→L2），再以合并涉及的工作区作用域调 `l3-maintenance.solidify`（L2→L3）    |
| `sweep`       | `l1-maintenance.sweep` → `l2-maintenance.trim` → `l3-maintenance.forget`（游标透传）                   |
| `candidates`  | `l1-maintenance.candidates` + `l2-maintenance.trim`（`dry_run`）+ `l3-maintenance.forget`（`dry_run`） |
| `view`        | `l1/l2/l3-maintenance.view` 三档拼接                                                                   |
| `edit`        | 按 `layer` 路由：`l3` → `l3-maintenance.edit`；`l1` / `l2` → `l2-maintenance.edit`                     |

- **水位归属**：sweep 水位（③ 可重算）**留在本门面**（`execute/watermark.ts`）。水位语义是「上次 sweep 的
  时间」，只对 L3 低权重扫描增量有效，但「是否推进」取决于三层汇总是否**全部无变更**——这是跨层判定，
  故由门面在拿到三层结果后统一决定；下层提供方只接收 `cursor` 参数，不各自维护水位。
- **写与失败**：三层提供方在各自调用内读写 owner 服务；门面在任一层返回结构化失败时回错误值。
  跨层非原子：前层已写、后层失败时不回滚（原单体会先算后写，故此处有轻微放宽，见下「已知差异」）。
- **公开形状不变**：`consolidate` / `sweep` / `candidates` / `view` / `edit` 的返回字段与拆分前一致，
  消费方（`tools` 的 `memory.candidates`、`ui-settings` 的 `memory.view` / `memory.edit`）**零改动**。

## 策略参数（`schema/memory-maintenance.json` 顶层 `params`，可热改）

| 参数                           | 缺省       | 用途                                      |
| ------------------------------ | ---------- | ----------------------------------------- |
| `l1_ttl_ms`                    | `86400000` | L1 硬 TTL（24h）                          |
| `l2_capacity`                  | `200`      | 单工作区 L2 facts 容量上限                |
| `l3_capacity`                  | `500`      | L3 存活条目容量上限                       |
| `dedup_cosine_threshold`       | `0.9`      | 去重余弦阈值（合并 / 固化）               |
| `consolidate_weight_threshold` | `0.7`      | 固化权重阈值（L2 项 → L3）                |
| `candidate_weight_threshold`   | `0.2`      | 候选 / 淘汰低权重阈值                     |
| `solidify_full_sources`        | `4`        | 固化权重推导：`min(1, sources 数 / 该值)` |

- 门面按 args 解析后把显式值透传给对应提供方；覆盖值形态非法回 `bad_args`。
- 周期：`schema.periodic` 两拍（`consolidate` 1h、`sweep` 30min），宿主按 `periodic.reads` 注入策略 body
  （`summarize`、阈值覆盖），门面透传，owner 数据由提供方自读。

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

## 已知差异（拆分引入）

- 跨层写非原子：`sweep` / `consolidate` 由三层提供方分别落写，若前层成功、后层失败，不回滚前层。
- `merge` 的 L1→L2 去重改用整段文本一次 `embedding.embed`（不切块）；单块文本结果与拆分前一致。
- 契约超时逐跳收紧：门面对各提供方的反向调用等待上限严格嵌套在 `memory-maintenance.consolidate` 4800000 /
  `memory-maintenance.sweep` 900000 之内（见 `execute/port-link.ts` 常量）。

## 运行

```sh
npm test                        # 协议级 + 包形状 + 水位测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（可能需按新 needs 更新，见下）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
