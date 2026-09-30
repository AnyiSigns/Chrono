# embedding（向量化门面 / 扩展点拥有者）

插件化 agent 运行时的**向量化门面**：本服务不持有向量模型，而是扩展类 `embedding-provider` 的
**拥有方**（声明契约 `slots`）与**消费方**（`needs` 为 `many`）。它按请求 `model` 从宿主注入的成员表里
选出一个提供方，带 `provider` 反向调用该成员的 `embed`，并原样返回结果。

对外公开面不变：能力类 / 方法仍为 `embedding` → `embed`；本插件是**通用能力**：任何需要向量化的身份
都可 `needs {embedding: one}` 接入，对外形状零改动。

- 身份：`embedding`
- 能力类 / 方法：`embedding` → `embed`
- 拥有扩展类：`embedding-provider`（`slots`，契约方法 `embed` / `describe-models`）
- 消费扩展类：`needs { embedding-provider: many }`
- 命令：无（成员无 `terms/`：无命令即无入口 term，省略该目录）
- 成员：`execute`（Rust 服务 + `launch.mjs`）、`schema`（`embedding.json`）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧）

## 选择规则（确定性）

1. **请求指定 `model`**：恰好一个成员在其 `describe-models` 里声明该 model → 选它；
   0 个 → 错误 `unknown_model`；多个 → 错误 `ambiguous_model`（按成员码元序列出候选）。
2. **未指定 `model`（字典序首命中）**：成员按身份名码元序，取首个声明了模型的成员的首个模型。
3. 某成员 `describe-models` 失败（未就绪 / 出错）只跳过该成员，不阻断选择；结果按进程缓存。
4. 选中成员的 `embed` 结果做轻校验（`{model, dim>0, vectors:[…]}`），形状不符回 `provider_bad_result`。

选择只依赖宿主注入的成员表与各成员的 `describe-models`，故**加减提供方 = 世界成员表变化** →
宿主按世界重解析、重启消费方进程并重注入；本选择器代码零改动。

## 扩展点接法

```jsonc
// 拥有方 embedding：声明契约并消费自己的扩展点
"slots": { "embedding-provider": { "methods": ["embed", "describe-models"] } },
"needs": { "embedding-provider": { "mode": "many" } }
```

- **提供方自注册**：新插件 `implements: ["embedding-provider"]`，声明方法 `embed` / `describe-models`，
  随 `plugin.json` 入世即被发现，**不改本插件**。参考提供方 `plugins/embedding-local`。
- **成员表注入**：宿主按世界能力索引解析本插件 `needs` 中 `mode:"many"` 的成员表，随服务工厂上下文注入；
  Rust 侧经 spawn env `CHRONO_PLUGIN_MANY_NEEDS`（形如 `{"embedding-provider":["…"]}`）解析。
- **反向按成员定位**：`port.call` 帧带 `provider`（目标提供方身份名）；宿主校验「该类在发出者 `needs`
  且为 `many`」且「目标 ∈ 索引(类)」后，按该成员端点调用其 `embed`。
- **契约**：能力类 method 契约单源在拥有方 `slots`；提供方 `methods[cap]` 为其子集（此处即全集），
  消费方 `needs.many` 可省 `methods`（有拥有方契约时）。

## 能力契约

```jsonc
// embed 入参（单条或批量；model 缺省按成员码元序首命中）
{ "texts": ["…"], "model": "…" }
// embed 出参（由选中的提供方产出；vectors 与 texts 一一对应，每维 dim，已 L2 归一）
{ "model": "…", "dim": 384, "vectors": [[/* dim float */], …] }
```

模型清单 / 维度随提供方声明（见提供方 schema），门面只固定对外形状。服务不读投影、无写通道：
一切输入随 bag 由调用方入口 term 传入。

## 服务协议

`docs/protocol.md` §二：`hello` / `manifest` / `call` / `result` / `error` / `reload` / `drain` / `bye` / `probe` / `pong`。
stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。
向量化经反向 `port.call embedding-provider.embed`（带 `provider`）：反向调用帧立即结算，不排队。

## 测试

```bash
npm test   # 等价 cargo test：选择器规则单测 + 黑盒集成测试（驱动真实二进制 + 夹具提供方）
```

集成测试扮演宿主，按 `provider` 把门面的反向调用路由到假提供方与真实夹具
`tests/fixtures/plugins/embedding-fixture`（声明模型 `x`），覆盖按 model 选成员、未知 / 歧义报错、
默认首命中，以及成员集由 `[local]` 变为 `[local, fixture]` 重注入后消费方可选到新成员。
