# evolve-metrics（指标层 · 残留门面）

自进化环的**指标层门面**（Rust）。本插件已拆分为四个提供方，**身份 / 能力类 / 公开方法面不变**，
既有消费方（`loop-policy` 的 `shadow`、`tools` 的 `record` 绑定）**零改动**：

| 方法        | 委派目标                    | 职责                                     |
| ----------- | --------------------------- | ---------------------------------------- |
| `aggregate` | `evolve-evidence.aggregate` | 七类证据聚合 + `orchestration.unhealthy` |
| `record`    | `evolve-evidence.record`    | `user_request` 证据生产者                |
| `sweep`     | `evolve-sweep.sweep`        | 轨迹 / 证据窗口保留与清理计划            |
| `shadow`    | `evolve-shadow.shadow`      | 影子回放三态与指标 def                   |

链原语（`read-chain` / `patch-plan` / `thresholds` / `hash`）住 `evolve-ledger`，由三个算法提供方消费。

- 身份：`evolve-metrics`
- 能力类 / 方法：`evolve-metrics` → `aggregate` / `sweep` / `shadow` / `record`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-metrics.json`）
- pins：无（`{}`；原 `host` pin 随 `shadow` 迁至 `evolve-shadow`）
- needs：`evolve-ledger(one)`、`evolve-evidence(one)`、`evolve-sweep(one)`、`evolve-shadow(one)`
- 状态档：`recomputable`（门面无自有状态；③ 成本异常基线缓存随 `evolve-evidence`）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-metrics.aggregate`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- **不做提案**（分签红线随提供方保持）/ 不读投影 / 不写链 / 不取时间不用随机；
  门面只做门禁与转交，重逻辑住相对消费方的提供方。

## 委派契约

门面把调用 `args` **原样**转交提供方，并把调用帧 `env` 注入 `bag.__env`（反向 `port.call` 不携带帧 env），
提供方据此取 `run` / `thread` / `now`。提供方回包原样返回。

## 周期触发与 ③ 归属（随方法迁出）

- `aggregate` 周期（每 600000ms，reads `trace` + `thresholds`）迁入 **`evolve-evidence`**；
- `sweep` 周期（每 3600000ms，reads `trace` + `verdicts`）迁入 **`evolve-sweep`**；
- ③ 成本异常基线缓存 `baselines.json` 迁入 **`evolve-evidence`**（`state/plugins/evolve-evidence/baselines.json`）。

## 方法契约

各方法入参 / 结果形状以对应提供方 schema 为准：
`evolve-evidence`（`aggregate` / `record`）、`evolve-sweep`（`sweep`）、`evolve-shadow`（`shadow`）。

## 测试

```sh
npm test     # 等价 cargo test：单元（门禁 / 委派路由 / env 转交）+ 集成（黑盒经协议驱动真实二进制，测试充当最小宿主应答提供方反向调用）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **门面为两跳委派端点**：门面 → 提供方 → 台账。任一提供方缺失即门面该方法不可用（`needs` 解析为 `one`）。
