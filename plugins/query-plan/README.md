# query-plan（查询规划 · L3 召回前置）

L3 长期记忆召回前的**查询规划服务**（Rust）：把原始查询与 L1 goal 构造成基础查询，再按开关生成
2–3 个同义 / 相关子查询（去重封顶），回 `{query, queries}` 供召回流水线做向量化与索引检索。
纯计算 + 反向调用，**无写通道、不读投影、不取时间**；多查询默认关，关闭时同输入同输出、逐字节可回放。

- 身份：`query-plan`
- 能力类 / 方法：`query-plan` → `plan`
- 命令：无
- 成员：`execute`（`launch.mjs`）、`src`（Rust 服务源码）、`schema`（`query-plan.json`）
- pins：无
- needs：`model`（多查询子查询生成，可关）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）
- 健康探针自述：`query-plan.plan`（宿主健康判定走协议级 `probe` / `pong`）

## 边界

- **不做**：向量化（归 `embedding`）/ 索引检索与条目读取（归 `memory-store`）/ 排序与重排（归 `rerank`）/
  召回过滤 / 衰减 / 去重 / 预算截断（归 `memory-retrieval`）/ 直接写世界。
- 服务不 import 宿主与内核；跨插件只走反向调用 `model.chat`。
- 无写通道：结果只是返回值，不产 `$directives`。

## 规划流水线

```
1 查询构造   基础查询 = 顶层 query；query 为空取 goal，goal 为空取 query，否则 query + "\n" + goal
2 多查询     （开关，默认关）eff model.chat 生成 2–3 个子查询；解析失败 / 无连接即降级为单查询
3 去重封顶   子查询去重、剔除空项，并入后封顶 4 条（基础查询 + 至多 3）
```

## 方法契约

### `plan(args) -> { ok, query, queries }`

**args 键形状**（服务不读投影；以下数据由调用方随 args 传入）：

| 键             | 形状    | 说明                                                       |
| -------------- | ------- | ---------------------------------------------------------- |
| `query`        | string  | 当前轮原始查询文本。                                       |
| `goal`         | string  | 本会话 L1 goal / 摘要，拼进基础查询。                      |
| `model_config` | object  | 多查询时 `model.chat` 的连接实例；缺失时多查询降级为关闭。 |
| `multi_query`  | boolean | 多查询开关，默认 `false`。                                 |

**返回**：`query` 为构造后的基础查询，`queries` 为实际查询集（首项恒等于 `query`）。
多查询开启且 `model_config` 存在时，`queries` 可含至多 3 条追加子查询；`model.chat` 失败 / 解析不出
一律降级为单查询，不报错。

## 与调用方的关系

- `memory-retrieval` 的 `search` 在召回流水线开头 eff 本服务 `plan`，用返回的 `queries` 做逐条向量化与
  索引检索。`query` / `queries` 原样进入召回结果，签名与结果形状不变。
- 多查询打开时，该次规划的模型输出不参与重放（已知限制，与 `model-protocol` 同口径）。

## 测试

```sh
npm test          # 等价 cargo test：纯函数单测（查询构造 / 多查询去重封顶 / 解析容错）
                  # + 集成 test/integration.rs（黑盒经协议驱动真实二进制，桥接注入假 model）
```

## `.worldignore`

声明 `target/`（构建产物）、`test/`（cargo 测试）、`tools/`（本地工具）不入世界；
`plugin.json` / `package.json` / `Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` / `src/` / `schema/` 随源码入世。

## 已知限制

- **Rust 首次构建需网络**（下载 `serde_json` crates）；缓存就位后离线可复现。
- **多查询**依赖 `model_config`（连接实例）；缺失时降级为关闭，不报错。模型输出不参与重放。
