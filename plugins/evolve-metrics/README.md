# evolve-metrics（指标层 · 证据聚合）

自进化环的**指标层**（Rust，纯计算、非 LLM、同输入同输出）：读轨迹投影 → 失败模式聚类 / `post_failure` /
成本异常 / 实例漂移 / 折叠候选 / `no_progress` / `verify_failure` 七类 → 产 **`kind:'evidence'` 证据**条目写计划。
另有 `shadow`（门禁第二道影子回放）、`sweep`（轨迹清理）、`record`（user_request 证据生产者）。

**分签红线（结构性）**：本插件**只产证据、不产提案**。给指标层加任何提案面就等于「自己诊断自己改」，
评审再也无法机械验证证据是否被裁剪来迎合某个提案。本插件输出里永远不含 `kind:'proposal'`。

- 身份：`evolve-metrics`
- 能力类 / 方法：`evolve-metrics` → `aggregate` / `sweep` / `shadow` / `record`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-metrics.json`）
- pins：`host`（保留身份：`shadow` 经 `host.audit` 读历史 `EffectAudit` 作补充对照源）
- 状态档：`recomputable`（③ 可重算；基线缓存丢失只影响一次重算）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-metrics.aggregate`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- **不做提案**（分签）/ 不调模型 / 不直接写链（只返回计划）/ 不判「该不该改」（那是提案层与人闸）/
  不读世界本体（只认 bag）/ 不取时间不用随机（`now` 由 bag 或调用帧 `env` 传入）。

## 方法契约

服务无写通道：一切写经计划值 `{"$directives":[…]}` 交宿主落账（周期方法条目由宿主按该身份落账）。
批内 `$n`（0 基）指向同批更早 `put` 的 def 键，故新台账 body 的链头可引用同批 put 的条目。

### `aggregate(bag) -> { evidence, unhealthy, $directives }`

读轨迹窗口 → 产七类证据 → 返回写计划（`batch`：证据条目 + 新 `evolution` body 索引）。

```jsonc
// bag（周期路径由宿主按 schema.periodic.reads 注入；loop-policy 路径由其 bag 传）
{ "trace": { /* evolution 身份投影 {body,refs} 或条目数组 */ },
  "trace_entries": [ /* loop-policy 内存路径：轨迹条目数组 */ ],
  "thresholds": { /* 见下「阈值契约」 */ },
  "now": 0, "refusal_codes": { "capability_mismatch": "graph" } }
```

- 证据类：`failure_cluster` / `post_failure` / `cost_anomaly` / `instance_drift` / `fold_candidate` /
  `no_progress` / `verify_failure`。空轨迹返回空集、不报错。
- 聚类键 `(code, attributable_to, workspace_id, contract_id?)`：`workspace_id` **必须分区**（跨工作区不合并）；
  `attributable_to='user'` 单独成簇、`capability_gap:false`（偏好不是能力缺口）。
  仅 `node` 归因且**跨多个 `contract_id` 重复**才是新能力证据（`capability_gap:true`）。
- 两档聚合：单工作区达阈 ⇒ `scope_support:"workspace"`；同一 `(码,归因)` 在 ≥ `min_workspaces` 个工作区
  **独立**出现 ⇒ `scope_support:"global"`。证据条目附 `scope_support` / `capability_gap` / `contracts`。
- 发 **`orchestration.unhealthy`** 事件：最近连续 `refused` 收口 ≥ `unhealthy_refused_streak` 即发
  （与 ui-settings 健康判定同口径；宿主透传 → `ui-notify` / `ui-settings`）。事件是数据变化的机械通知，非业务判定。

### `sweep(bag) -> { swept, retained, referenced, $directives }`

读轨迹窗口 + verdicts 引用集 → 产清理计划（写新 `evolution` body 索引、不含过期条目）。

- 保留 = 最新 `trace_retention_rounds` 条 **∪ 被 `verdict` 引用者**（无论多旧）——否则
  `verdict → proposal → evidence → trace` 溯源链断。
- 清理只动索引（`trace.retained` 列表），def 仍在链上（① 档既定代价，不是删除）。

### `shadow(bag) -> { status, metric, metric_id, $directives }`

影子回放（门禁第二道）：纯计算、零 token、**不调任何真实端口**（`host.audit` 是保留能力类，非端口）。

- 配对口径（v1）：按 `(port, method, args_hash)` 与 **evolution `trace.eff_log`** 配对回灌结果；
  `host.audit` 读历史 `EffectAudit` 保留为**补充对照源**（eff_log 缺匹配时按 `(port, method)` 兜底）。
- 三态：`pass`（所有 eff 都有匹配且结果一致）/ `fail`（同一配对键出现不一致 `result_hash`）/
  `unverified`（有 eff 无匹配历史；期望 eff 推导不出来时亦 fail-closed 记 `unverified`）。
- 期望 eff 点来源：显式 `expected_effs` > `graph.nodes` + `contracts`（`entry` 或 `effects.ports/methods`）。
- 产出指标 def 的 `put` 计划，供 loop-policy 写 `verdicts.gate.shadow` 引用；**本插件不写链**。

### `record(bag) -> { evidence_id, $directives }`

经 tools 的能力类工具绑定暴露（工具名 `record` 直绑本方法）。把用户原始消息 def 落成一条
`class:'user_request'` 证据（`put(证据) + put(新 evolution body) + add_gen`），返回 `evidence_id`。
纯计算、不调模型、不发 eff。`user_message_def` 由 loop-policy 在派发时注入。

## 阈值契约（读 loop-policy `thresholds`，本插件不重定义）

本插件**不重定义**任何数值调参，全部读 loop-policy `thresholds`。`thresholds` 在 loop-policy 是链式 tail 条目，
投影路径 `["ids","loop-policy","body","thresholds"]` 只给 `{tail,count}`；本服务接受
**扁平 map / `{tail,count}` 链 + refs / 身份投影 / 条目数组**任一形状，并在缺失时用下列缺省：

| 阈值名 | 缺省 | 用途 |
| --- | --- | --- |
| `failure_cluster_n` | 3 | `failure_cluster` 达阈样本数 |
| `post_failure_ratio` / `post_failure_min` | 0.5 / 3 | `post_failure` 的 fail 占比与最小样本 |
| `cost_anomaly_multiple` | 2.0 | 四维用量中位数超基线倍数 |
| `drift_margin` / `drift_min_samples` | 0.2 / 5 | 实例滚动成功率跌破基线判据 |
| `fold_k` | 3 | 连续成功回合折叠候选 |
| `no_progress_n` | 3 | `l1_maxed` 反复达阈 |
| `verify_failure_n` / `verify_cluster_ratio` | 2 / 0.6 | verify 失败次数与详情聚类集中度 |
| `min_workspaces` | 2 | 跨工作区独立出现 ⇒ 可支撑 `scope:global` |
| `trace_retention_rounds` | 50 | `sweep` 保留回合数 |
| `unhealthy_refused_streak` | 3 | 连续 `refused` 收口触发 `orchestration.unhealthy` |

> **已与 loop-policy 对齐（2026-09-21）**：上表字段名与缺省值已由 loop-policy `loop-policy` 落地确认——
> `plugins/loop-policy/execute/seed.ts` 的 `DEFAULT_THRESHOLDS` 逐项包含本表全部 13 个字段名且缺省值一致
> （`failure_cluster_n=3`、`post_failure_ratio=0.5`、`post_failure_min=3`、`cost_anomaly_multiple=2.0`、
> `drift_margin=0.2`、`drift_min_samples=5`、`fold_k=3`、`no_progress_n=3`、`verify_failure_n=2`、
> `verify_cluster_ratio=0.6`、`min_workspaces=2`、`trace_retention_rounds=50`、`unhealthy_refused_streak=3`）。
> loop-policy `interpret` 把解析后的**扁平 thresholds map** 随 `evolve-metrics` bag 下传（`aggregate` / `shadow`），
> 本服务直接读扁平 map。字段名/语义以本表为准；loop-policy 只提供默认值，不重定义语义。

## 成本异常与实例漂移的窗口口径

- **成本异常**：同 `(workspace_id, contract_id)` 的步骤按链序取**较旧一半**作基线、**较新一半**作观测；
  任一维观测中位数 > 基线中位数 × `cost_anomaly_multiple` 即产证据。基线中位数走宿主 ③
  （`state/plugins/evolve-metrics/baselines.json`，`CHRONO_PLUGIN_STATE` 注入），键 = 基线样本确定性哈希；
  命中 / 未命中输出逐字节一致（计算确定性），缓存丢失只影响一次重算。
- **实例漂移**：按 `chosen_instance` 分组，同样较旧 / 较新各半算成功率；观测率 < 基线率 − `drift_margin`
  且两侧样本 ≥ `drift_min_samples` 即产证据。

## 测试与 E2E

```sh
npm test                     # 等价 cargo test：单元（聚类分区 / 七类 / 三态 / 计划形状 / 确定性 / 阈值解析）
                             # + 集成 test/integration.rs（黑盒经协议驱动真实二进制）
node tools/e2e-smoke.mjs     # 离线入世 E2E：pack + seed + 读世界验证声明 / periodic / .worldignore（不跑 cargo）
```

E2E **不起宿主**，故不触发宿主侧依赖物化（`cargo build`）；它验证：声明（identity / implements /
methods / start / members / `pins.host` 解析到宿主保留能力类）、`periodic` 两拍（`sweep` + `aggregate`，
`aggregate.reads` 注入 `trace` + `thresholds`）、`.worldignore`（`test/` / `target/` / `tools/` 不入源码树，
`src/` / `execute/` / `schema/` / `Cargo.toml` / `Cargo.lock` 入树）。

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界；
`plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` / `src/` / `schema/` 随源码入世。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **`shadow` 的新图 eff 点推导**依赖调用方给出 `expected_effs` 或 `graph.nodes` + `contracts`；
  给不出时 fail-closed 记 `unverified`（不假装 pass）。v1 配对只按 `(port, method, args_hash)` 与
  `trace.eff_log` 对齐，未消费 `directives_summary` / `ctx_summary`（待 loop-policy 解释器落地后可与图重放对齐）。
- **`sweep` 的「新索引」形状**：在 `trace` 对象上追加 `retained` / `dropped` / `swept_at` 字段（`tail` / `count`
  仍按 `evolution` schema）；过期条目的 def 仍在链上（① 档既定代价）。待 evolution / loop-policy 落地后可与台账端再对齐。
- **`step.refusal` 的归因**需 `bag.refusal_codes`（拒绝码 → 归因）提供；缺省只用 `trace.refused_at`（自带归因）。
- **periodic.reads 路径与契约字面不同**：链式条目在投影 `refs` 闭包（`ids.<id>.refs`）里，只读
  `body` 拿不到条目，故本 schema 读整份身份投影（`aggregate`：`["ids","evolution"]` + `["ids","loop-policy"]`；
  `sweep`：`["ids","evolution"]`）。服务同时兼容契约的 `body` / `refs` 分开传形状，待 loop-policy 落地后对齐。
