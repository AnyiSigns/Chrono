# evolve-ledger（台账原语 · 链窗口 / 写计划 / 阈值 / 哈希）

自进化环的**台账原语**（Rust，纯计算、非 LLM、同输入同输出）：把调用方投影片段归一成可用形状——
读链窗口、构造台账写计划、解析阈值、算确定性哈希。所有被两处以上复用的台账逻辑住此，
上游（`evolve-metrics` 门面、`evolve-evidence` / `evolve-sweep` / `evolve-shadow` 提供方）
经反向 `port.call` 消费，不自带副本。

- 身份：`evolve-ledger`
- 能力类 / 方法：`evolve-ledger` → `read-chain` / `patch-plan` / `thresholds` / `hash`
- 命令：无（成员无 `terms/`）
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`evolve-ledger.json`）
- pins：无（`{}`）
- needs：无（本插件是原语提供方，只消费入参）
- 状态档：`recomputable`（本插件无自有状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`evolve-ledger.read-chain`（宿主健康判定实际走协议级 `probe` / `pong`）

## 边界

- 不读投影 / 不写链（只返回计划）/ 不取时间不用随机（`now` 由调用方解析）/ 无 needs 无 pins。

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

## 测试

```sh
npm test     # 等价 cargo test：单元（链解析 / 阈值 / 哈希 / 计划形状）+ 集成（黑盒经协议驱动真实二进制）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地 E2E 工具）不入世界。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde` / `serde_json` crates）；缓存就位后离线可复现。
