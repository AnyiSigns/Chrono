# evolve-metrics（指标层 · 证据 / 清理 / 影子 / 记录）

自进化环的**指标层**（Rust，纯计算、非 LLM、同输入同输出）。身份 / 能力类 / 公开方法面
`aggregate` / `sweep` / `shadow` / `record` 保持不变，既有消费方（`loop-policy` 的 `shadow`、
`tools` 的 `record` 绑定）零改动：

| 方法        | 职责                                                              |
| ----------- | ----------------------------------------------------------------- |
| `aggregate` | 七类证据聚合 + `orchestration.unhealthy` 事件                     |
| `record`    | `user_request` 证据生产者                                         |
| `sweep`     | 轨迹 / 证据窗口保留与清理计划（不动被引用的旧条目）               |
| `shadow`    | 影子回放三态与指标 def（`host.audit` 作补充对照源）               |

链原语（`read-chain` / `patch-plan` / `thresholds` / `hash`）住 `evolve-ledger`，经反向 `port.call` 消费。

- 身份：`evolve-metrics`
- 能力类 / 方法：`evolve-metrics` → `aggregate` / `sweep` / `shadow` / `record`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-metrics.json`）
- pins：`host`（`shadow` 经 `host.audit` 读历史 `EffectAudit`）
- needs：`evolve-ledger(one)`
- 状态档：`recomputable`（无链写；③ 成本异常基线缓存住宿主侧 `state/plugins/evolve-metrics/baselines.json`）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-metrics.aggregate`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- **不做提案** / 不读投影 / 不写链 / 不取时间不用随机；
  一切输入随 `bag` / 调用帧 `env` 传入，一切写经计划值 `{"$directives":[…]}` 交宿主落账。

## 周期触发

宿主按本插件 schema 的 `periodic` 数组触发：`aggregate` 每 600000ms（reads `trace` + `thresholds`）、
`sweep` 每 3600000ms（reads `trace` + `verdicts`），调用身份为 `evolve-metrics`。

## 方法契约

各方法入参 / 结果形状见 `schema/evolve-metrics.json`；数值调参一律读 loop-policy thresholds
（经 `evolve-ledger.thresholds` 归一），本插件不重定义。

## 测试

```sh
npm test     # 等价 cargo test：单元（门禁 / 四方法分派 / 台账消费）+ 集成（黑盒经协议驱动真实二进制，测试充当最小宿主应答 evolve-ledger 反向调用）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **台账原语为反向调用端点**：门面 → `evolve-ledger`，缺失即四方法不可用（`needs` 解析为 `one`）。
