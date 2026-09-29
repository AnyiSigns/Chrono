# evolve-shadow（影子回放提供方 · 三态）

自进化环的**影子回放提供方**（Rust，纯计算、零 token、同输入同输出）：候选新图按
`(port, method, args_hash)` 与历史 `trace.eff_log` 配对回灌结果，出 `pass` / `fail` / `unverified`，
产指标 def 的 `put` 计划供 `loop-policy` 写 `verdicts.gate.shadow` 引用。轨迹窗口 / 内核哈希 /
写计划构造经反向 `port.call evolve-ledger.*` 委派台账原语；历史 `EffectAudit` 经保留身份 `host.audit` 读。

- 身份：`evolve-shadow`
- 能力类 / 方法：`evolve-shadow` → `shadow`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-shadow.json`）
- pins：`host`（保留身份：`shadow` 经 `host.audit` 读历史 `EffectAudit` 作补充对照源）
- needs：`evolve-ledger`（`one`：链窗口 / 内核哈希 / 写计划）
- 状态档：`recomputable`（本插件无自有状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-shadow.shadow`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- 纯计算、零 token、**不调任何真实端口**（`host.audit` 是保留能力类，非端口）/
  不读投影（只认 bag）/ 不写链（只产 put 计划）/ 不取时间不用随机。

## 方法契约

### `shadow(bag) -> { status, metric, metric_id, $directives }`

- 配对口径：按 `(port, method, args_hash)` 与 `trace.eff_log` 配对；`host.audit` 读历史
  `EffectAudit` 保留为**补充对照源**（eff_log 缺匹配时按 `(port, method)` 兜底）。
- 三态：`pass`（所有 eff 都有匹配且结果一致）/ `fail`（同一配对键出现不一致 `result_hash`）/
  `unverified`（有 eff 无匹配历史；期望 eff 推导不出来时亦 fail-closed 记 `unverified`）。
- 期望 eff 点来源：显式 `expected_effs` > `graph.nodes` + `contracts`（`entry` 或 `effects.ports/methods`）。
- `metric_id` = 内核 `H({body: metric_def})`（64hex），供 `loop-policy` 写 `verdicts.gate.shadow` 引用；
  `$directives` 只含 `put(指标 def)`，**本插件不写链**。

## 测试

```sh
npm test     # 等价 cargo test：单元（三态 / 期望推导 / 兜底 / 指标 def）+ 集成（黑盒经协议驱动真实二进制，测试充当最小宿主应答台账反向调用）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **期望 eff 点推导**依赖调用方给出 `expected_effs` 或 `graph.nodes` + `contracts`；给不出时
  fail-closed 记 `unverified`。v1 配对只按 `(port, method, args_hash)` 与 `trace.eff_log` 对齐。
