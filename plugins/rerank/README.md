# rerank（候选重排原语 · L3 召回后置）

L3 长期记忆召回候选的**重排原语**（Rust）：先做 MMR（多样性）贪心排序，再按开关做 listwise 语义重排
（`model.chat`，默认关），回候选 `key` 顺序。纯计算 + 反向调用，**无写通道、不读投影、不取时间**；
语义重排默认关，关闭时同输入同输出、逐字节可回放。

- 身份：`rerank`
- 能力类 / 方法：`rerank` → `order`
- 命令：无
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`rerank.json`）
- pins：无
- needs：`embedding`（候选向量化）、`model`（语义重排，可关）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`rerank.order`（宿主健康判定走协议级 `probe` / `pong`）

## 边界

- **不做**：查询构造 / 多查询（归 `query-plan`）/ 索引检索与条目读取（归 `memory-store`）/
  过滤 / 衰减 / 去重 / 预算截断（归 `memory-retrieval`）/ 向量化实现（归 `embedding`）/ 直接写世界。
- 服务不 import 宿主与内核；跨插件只走反向调用 `embedding.embed` / `model.chat`。
- 无写通道：结果只是返回值，不产 `$directives`。

## 重排流水线

```
1 MMR       候选经 eff embedding.embed 向量化；lambda·rel(c) − (1−lambda)·max_{s∈已选} cos(c, s) 贪心选序
            向量化失败 / len 不符 / lambda ≥ 1 → 降级为分数序（score 降序、同分 key 升序）
2 语义重排  （开关，默认关）eff model.chat listwise 重排；失败 / 解析不出 → 保留 MMR 序
```

平手 / 未提及项均按确定规则（key 升序 / 原序追加）兜底。

## 方法契约

### `order(args) -> { ok, order }`

**args 键形状**（服务不读投影；以下数据由调用方随 args 传入）：

| 键             | 形状                 | 说明                                                                |
| -------------- | -------------------- | ------------------------------------------------------------------- |
| `items`        | `{key,score,text}[]` | 候选列表；`key` 在候选集内唯一，`text` 供向量化与提示词截断。       |
| `mmr_lambda`   | number               | MMR 相关度 / 多样性权衡，默认 `0.7`；`1.0` = 纯相关度（不向量化）。 |
| `rerank`       | boolean              | 语义重排开关，默认 `false`。                                        |
| `model`        | string               | 向量化模型 id，缺省 `granite-97m`。                                 |
| `model_config` | object               | 语义重排时 `model.chat` 的连接实例；缺失时语义重排降级为关闭。      |

**返回**：`order` 为候选 `key` 的重排后顺序（全排列）。MMR 向量化失败即降级为分数序；
语义重排失败 / 解析不出即保留 MMR 序，均不报错。

## 与调用方的关系

- `memory-retrieval` 的 `search` 在过滤 / 衰减 / 阈值 / 去重之后 eff 本服务 `order`，用返回的 `key`
  顺序重排候选，再按预算截断。默认 `mmr_lambda = 0.7`（MMR 开）、`rerank = false`。
- 语义重排打开时，该次重排的模型输出不参与重放（已知限制，与 `model-protocol` 同口径）。

## 测试

```sh
npm test          # 等价 cargo test：纯函数单测（余弦 / MMR / 分数降级 / 语义重排索引解析）
                  # + 集成 test/integration.rs（黑盒经协议驱动真实二进制，桥接注入假 embedding / model）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地工具）不入世界；
`plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` / `src/` / `schema/` 随源码入世。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde_json` crates）；缓存就位后离线可复现。
- **MMR 向量化**需要额外一次 `embedding.embed`；失败即降级为分数序（不报错）。
- **语义重排**依赖 `model_config`（连接实例）；缺失时降级为关闭，不报错。模型输出不参与重放。
