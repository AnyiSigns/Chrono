# evolve-ledger（台账原语 + 指标层 · 单一 Rust 身份）

自进化环的**台账原语 + 指标层**（Rust，纯计算、非 LLM、同输入同输出）：同一二进制同时承载
台账原语——读链窗口 / 构造写计划 / 解析阈值 / 算确定性哈希——与指标层——
证据聚合（aggregate）/ 用户请求记录（record）/ 台账清理（sweep）/ 影子回放（shadow）。
链原语就地调用（同一进程），历史审计经保留身份 `host` 的 `host.audit` 读。

- 身份：`evolve-ledger`
- 能力类 / 方法：
  - `evolve-ledger` → `read-chain` / `patch-plan` / `thresholds` / `hash`
  - `evolve-metrics` → `aggregate` / `sweep` / `shadow` / `record`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-ledger.json`）
- pins：`host` → `host`（`shadow` 经 `host.audit` 读历史审计）
- needs：无（本插件是原语与指标提供方，只消费入参与调用帧 env）
- 状态档：`recomputable`（无链写；成本异常基线缓存住宿主侧 `state/plugins/evolve-ledger/`）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-ledger.read-chain`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- 不读投影 / 不写链（只返回计划）/ 不取时间不用随机（`now` 由调用方解析）/ 无 needs，仅 pin 保留身份 `host`。

## 方法契约

### `read-chain({bag}) -> { trace, evidence, body, base, refs, refusal_codes }`

解析 bag：轨迹 / 证据窗口（链式 `tail` + refs 闭包 / `retained` 权威边界 / 显式条目数组 / 身份投影）、
当前 evolution body（剔除 `refs` / `data_gen`）、数据世代 `base`、引用闭包、拒绝码归因表。
条目跨身份线形 `{def, body}`；缺失字段为 `null`。

### `thresholds({bag}) -> { values }`

把 `thresholds` 归一成扁平 `{name: number}`：接受扁平 map / `{tail,count}` 链 + refs / 身份投影 / 条目数组。

### `hash({values, mode}) -> { hashes }`

批量哈希，与 `values` 同序。`content` = FNV-1a 64 over canonical JSON；`canonical` = 规范 JSON 串；
`kernel` = 内核 `H`（sha256(utf8(canonicalJson))，64 hex，供 def 键对拍）；`fnv` = 字面串 FNV。

### `patch-plan({gen_id?, body, base?, append|replace|puts}) -> { $directives }`

- `append`：`{section, entries}`——向 section 追加条目，自动为条目串 `prev`、刷新 `tail`/`count`，
  按 `base` 决定写整份 body 还是补丁 def，并产 `add_gen`。
- `replace`：`{section: index}`——以给定索引整体替换 section（`sweep` 用）。
- `puts`：只产 `put` 批、无 `add_gen`（无链写）。

`body` 为 `null` 时不产写。`add_gen` 目标身份由 `gen_id` 给出（缺省 `evolution`）。

### 指标层（能力类 `evolve-metrics`）

- `aggregate({bag, now?}, env) -> { evidence, unhealthy, $directives }`：读轨迹窗口产七类证据，
  按最近连续 refused 收口发 `orchestration.unhealthy` 事件；一切写经计划值交宿主落账。
- `record({bag}, env) -> { evidence_id, $directives }`：把用户原始消息落成一条 `class:'user_request'` 证据。
- `sweep({bag}, env) -> { swept, $directives }`：按保留阈值清理 trace / evidence 窗口。
- `shadow({bag}, env) -> { status, metric, metric_id, $directives }`：影子回放三态门禁，
  `eff_log` 缺匹配时经 `host.audit` 作补充对照源。

指标层数值调参一律读 `loop-policy` 的 `thresholds`（经本插件的 `thresholds` 归一），不重定义。

## 测试

```sh
npm test     # 等价 cargo test：单元（链解析 / 阈值 / 哈希 / 计划形状）+ 集成（黑盒经协议驱动真实二进制）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
