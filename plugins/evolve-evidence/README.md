# evolve-evidence（证据提供方 · 七类证据 / record）

自进化环的**证据提供方**（Rust，纯计算、非 LLM、同输入同输出）：读轨迹窗口 → 七类失败模式证据 →
产 `kind:'evidence'` 证据条目写计划；另有 `record`（user_request 证据生产者）。
链窗口读取 / 阈值解析 / 哈希 / 写计划构造经反向 `port.call evolve-ledger.*` 委派台账原语。

**分签红线（结构性）**：本插件**只产证据、不产提案**。给指标层加任何提案面就等于「自己诊断自己改」，
评审再也无法机械验证证据是否被裁剪来迎合某个提案。本插件输出里永远不含 `kind:'proposal'`。

- 身份：`evolve-evidence`
- 能力类 / 方法：`evolve-evidence` → `aggregate` / `record`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-evidence.json`）
- pins：无（`{}`）
- needs：`evolve-ledger`（`one`：链窗口 / 阈值 / 哈希 / 写计划）
- 状态档：`recomputable`（③ 成本异常基线缓存 `baselines.json`）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-evidence.aggregate`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- **不做提案**（分签）/ 不调模型 / 不直接写链（只返回计划）/ 不判「该不该改」/
  不读世界本体（只认 bag）/ 不取时间不用随机（`now` 由 bag 或调用帧 `env` 传入）。
- 不本地复刻链解析 / 阈值 / 哈希：全部经 `evolve-ledger` 消费（原语下沉）。

## 方法契约

### `aggregate(bag) -> { evidence, unhealthy, $directives }`

读轨迹窗口 → 产七类证据 → 返回写计划（`batch`：证据条目 + 新 `evolution` body 索引）。
证据类：`failure_cluster` / `post_failure` / `cost_anomaly` / `instance_drift` / `fold_candidate` /
`no_progress` / `verify_failure`。空轨迹返回空集、不报错。发 **`orchestration.unhealthy`** 事件
（最近连续 `refused` 收口 ≥ `unhealthy_refused_streak`；宿主透传）。

### `record(bag) -> { evidence_id, $directives }`

经 `evolve-metrics` 门面的能力类工具绑定暴露（工具名 `record` 直绑门面 `record`，门面转交本方法）。
把用户原始消息 def 落成一条 `class:'user_request'` 证据。

## ③ 归属

成本异常（`cost_anomaly`）的基线中位数缓存住 `state/plugins/evolve-evidence/baselines.json`
（`CHRONO_PLUGIN_STATE` 注入）；命中 / 未命中输出逐字节一致，缓存丢失只影响一次重算。
基线键 = 基线样本确定性内容哈希。

## 阈值契约

本插件**不重定义**任何数值调参，全部读 loop-policy `thresholds`（经 `evolve-ledger.thresholds` 归一成扁平 map）。
字段名与缺省以 `evolve-metrics` README「阈值契约」表为准。

## 测试

```sh
npm test     # 等价 cargo test：单元（七类 / 聚类分区 / 三态 / 计划形状 / ③）+ 集成（黑盒经协议驱动真实二进制，测试充当最小宿主应答台账反向调用）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
- **reverse 调用不携带帧 env**：门面把调用帧 env 经 `bag.__env` 转交；周期路径由宿主直接填帧 env。
