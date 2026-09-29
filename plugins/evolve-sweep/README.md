# evolve-sweep（台账清理提供方 · 轨迹 / 证据窗口保留）

自进化环的**台账清理提供方**（Rust，纯计算、非 LLM、同输入同输出）：读轨迹 / 证据窗口 + 引用集 →
产清理计划（写新 `evolution` body 索引、不含过期条目）。链窗口读取 / 阈值解析 / 写计划构造经反向
`port.call evolve-ledger.*` 委派台账原语。

- 身份：`evolve-sweep`
- 能力类 / 方法：`evolve-sweep` → `sweep`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-sweep.json`）
- pins：无（`{}`）
- needs：`evolve-ledger`（`one`：链窗口 / 阈值 / 写计划）
- 状态档：`recomputable`（本插件无自有状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-sweep.sweep`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- 不读投影 / 不直接写链（只返回计划）/ 不取时间不用随机（`now` 由 bag 或调用帧 `env` 传入）/
  不本地复刻链解析 / 阈值 / 写计划。

## 方法契约

### `sweep(bag) -> { swept, retained, referenced, evidence_*, $directives }`

读轨迹窗口 + evidence 链 + verdicts/proposals 引用集 → 产清理计划（写新 `evolution` body 索引）。

- 轨迹保留 = 最新 `trace_retention_rounds` 条 **∪ 被 `verdict` 引用者**（无论多旧）——否则
  `verdict → proposal → evidence → trace` 溯源链断。
- 证据保留 = 最新 `evidence_retention_rounds` 条 **∪ 被 `verdict` / `proposal` 的 `evidence_ids` 引用者**。
- 两链同形写回 `retained` 显式列表（权威边界，防窗口不缩、`swept` 每拍重复）；清理只动索引，
  def 仍在链上（① 档既定代价，不是删除）。

## 周期触发

`sweep` 每 `3600000ms` 由宿主按 `schema.periodic.reads`（`trace` + `verdicts`）注入后触发；
写计划以 `evolution` 身份落账。周期触发随方法由 `evolve-metrics` schema 迁入本插件。

## ③ 归属

本插件无自有 ③ 状态。

## 测试

```sh
npm test     # 等价 cargo test：单元（窗口 / 引用强留 / retained 边界 / 计划形状）+ 集成（黑盒经协议驱动真实二进制，测试充当最小宿主应答台账反向调用）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **reverse 调用不携带帧 env**：门面把调用帧 env 经 `bag.__env` 转交；周期路径由宿主直接填帧 env。
