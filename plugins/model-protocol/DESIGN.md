# #12 `model-protocol`（协议 + 发现 + 档案 + 韧性）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 12 / `model-protocol` |
| 职责 | **唯一的模型 IO 服务**：多 SDK / 三协议 HTTP + SSE（**混合**）+ **调用韧性**（重试 / 退避 / 限流 / 流断重连）+ `discover` + `profile`（定期后台同步）+ `vendors` |
| 依赖 | `->` 24（pins：密钥解析）；`+` 2（读连接实例与所选模型）、4–10（读 `sdk` / `quirks` / `default_reasoning`）；`<-` 14、17（pins）、19、22、33、34、49 |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["model"]`，`methods: {model:["chat","complete","vendors","discover","profile","sync"]}` |
| 命令 | `model.sync`（无参；**宿主定时触发**，宿主**直接调本方法**，见 `host.md` §五 定时触发「调指定命令 / 方法」）——其余命令面在 17（#40 按名调用 `model.profile`） |
| schema | `schema/request.json` / `schema/response.json` / `schema/discover.json` / `schema/profile.json` / `schema/resilience.json` |
| 机制 | 见下「chat / 推理 / 流式与 usage / 韧性 / discover / profile·sync / vendors」 |
| 边界 | 不做：降级链（归 34）/ 落账 / **密钥解析（一律归 24）** / 厂商适配数据（归 4–10；本插件只按 `sdk` / `quirks` 机械解释）/ 直接写世界 / 图拓扑（归 33） |
| 验收 | 1) 各 `impl`（protocol / sdk）真调用；2) 流式不重不漏；3) 韧性生效（瞬时错误重试、429 退避、流断重连、超时）；4) `discover` / `profile` 结构化错误；5) 推理默认开启：有档位传参、无值用模型默认；6) `profile` 只写所选模型且可回放；7) 换实现不改调用方；8) 世界无明文密钥 |
| 状态 | 细节设计（2026-09-19）：**混合实现**（三协议自实现 + 怪厂商 SDK）；**韧性全进 v1**；`quirks` 声明式机械解释；`profile` 定期后台同步（宿主定时触发）；**工具位（tool_calls 编解码）v1 一并做**（原「阶段 3 补」属已废弃的分阶段口径，#33 种子图 `agent.step` v1 即产出 tool_calls，缺它则工具路径不通）。**本轮补**：`model.sync` 命令（宿主直接调方法触发，**无需入口 term**、服务不自 eff）；`profile` / `sync` 写前去重 + 按 `#2` 并发语义 |

## chat（唯一模型调用路径）

```
chat(bag)：
  读 #2 config.providers.<vendor>：base_url / auth_ref / 所选 model / params /（自定义还读 protocol）
  读 #4–10 的 sdk + quirks（预设厂商）
  auth_ref -> eff 24 解析成句柄（明文不出现在审计）
  impl = quirks.impl：
    protocol -> 自实现 HTTP + SSE（openai-chat / openai-responses / anthropic-messages）
    sdk      -> 加载 sdk_package（随包投递、宿主侧 ③）
  编请求：messages / temperature / max_tokens（按 max_tokens_field）/ reasoning（按 reasoning_field·map）
  流式逐段发 event(topic="model.delta")；返回最终值（含 usage）
```

- **推理默认开启（无开关）**：`params.reasoning` 有值 → 经 `reasoning_map` 编进 `reasoning_field`；无值 → 用模型默认档（不传字段）。
- **`chat` 非幂等、永不进宿主结果缓存**（`temperature=0` 也不保证逐字节一致；缓存会掩盖真实漂移）。
- `quirks` **声明式机械解释**（`#4 vendor-openai` 规范）：`system_role` / `auth_style` / `auth_header` / `reasoning_field`·`reasoning_map`·`reasoning_response_field` / `max_tokens_field` / `models_path` / `stream_usage` / `extra_headers`；**本插件不加厂商分支**——按 `impl` 分派**有界适配器**（`protocol`×3 / `sdk` 一种）；`impl=sdk` 时 `reasoning_field` 允许嵌套点路径（如 Google `thinkingConfig.thinkingBudget`），由该适配器解释，不散落厂商判断。`reasoning_map` 值类型为 `string | number | boolean`（各厂商编码不同）。
- **SDK 载具（v1 口径）**：`impl=sdk` 的 SDK 包（如 `@google/genai`）作为**本插件自己的 npm 依赖**（`package.json` dependencies + lockfile 钉版本）——不依赖其他插件包、不 import 内核，符合 `plugins.md` §三；`node_modules` 由**通用排除规则**排除、**不进世界源码树**，宿主物化时按 `package.json` / lockfile 从**宿主侧 ③ 依赖缓存**恢复（与 #20 的 Rust `target/` 同路）；`sdk_package` 缺失 / 加载失败 → `model_unsupported`。**世界只存 `quirks.sdk_package` 这个名字，不存 SDK 本体。**

## complete（非流式单次补全，2026-09-19 补）

```
complete(bag)：同 chat 的连接 / 密钥（eff 24）/ 韧性路径，但 **不流式**：
  读 #2 config 的 vendor / model / params（同 chat）
  编请求 -> 单次 HTTP -> 返回 { text, usage }
  不发 event(model.delta)（调用方不期望流）
```

- **给谁用**：`#49 session-title` 的标题生成（短、非流式）；未来其它「旁路小补全」同路。
- **与 `chat` 的差别**：不流式、**不发 `model.delta`**、不进消息流；其余（密钥句柄 / 重试 / 退避 / 限流 / 超时 / 取消）**完全同 `chat`**，不新写一套。
- `complete` 也**非幂等**（同 `chat`，`temperature=0` 不保证逐字节一致）。

## 流式与 usage

- SSE 逐段解析：`text` / `reasoning`（`reasoning_response_field`）/ `tool_calls`（v1 一并做，见状态行）/ 结束块。
- **流式不重不漏**：以累积索引去重；断流按韧性处理。
- `usage` 来源按 `stream_usage`（`final_chunk` / `separate` / `none`）；无 usage 则不计。

## 韧性（v1 全做）

| 项 | 口径 |
| --- | --- |
| 瞬时重试 | 网络错误 / 5xx / 流断 → 重试上限 `max_retries`（schema）；4xx 不重试（429 除外） |
| 退避 | 指数退避 + 可选抖动（默认**关**，保审计可预期）；参数住 `schema/resilience.json` |
| 限流 | 429 → 尊重 `Retry-After` + 每 provider 令牌桶（宿主侧 ③，可重算）；超上限结构化失败 |
| 流断重连 | SSE 断开 → 支持 resume 的厂商从最后索引续；否则整请求重试（受上限） |
| 超时 | 单次调用超时已落地（`--call-timeout-ms` / `CHRONO_CALL_TIMEOUT_MS`）；超时与连接 / 帧 / 进程死亡同归「没执行」 |
| 取消 | 尊重 `cancel{run}`：中止在途、丢弃未完成流 |

## discover / profile·sync / vendors

| 方法 | 输入 | 输出 | 落世界 |
| --- | --- | --- | --- |
| `discover` | 槽 `{url, auth_ref}` | 规范化模型 id 列表（`GET {base_url}{models_path}` + 鉴权） | 否 |
| `profile` | `{vendor, ids}` | 拉 models.dev → 只取所选模型 → 写 `#2 config` 的**写计划**（`context_window` / `max_output` / `reasoning` / `modalities`） | 是（计划） |
| `sync` | 周期触发 | 同 `profile`（对已选模型批量刷新） | 是（计划） |
| `vendors` | — | 枚举 `vendor-*` 模板，每项 `{identity, default_base_url, default_auth_ref_name, default_reasoning}`（读投影，供 #17 S1 预填） | 否 |

- **`profile` 入参来源（D8）**：调用方（#17 S1 / #40）的**入口 term 从 `+ 2` 投影读当前 `vendor` 与所选 `ids`**，随 args 传入本方法；本服务不读投影（execute-only）。

- **定期后台同步**：`sync` 由**宿主定时触发**（宿主待补能力，见下）按 `schema` 里的周期构造一次 run、**直接调方法 `model.sync`**（`host.md` §五 定时触发：调指定命令 / 方法；**无入口 term、服务不自 eff**）；不后台轮询、不写世界（仍走计划）；所需 `#2` 投影片段由宿主按 `schema.periodic.reads` **机械注入 bag**（服务不读投影，D8）。**写前去重**：与 `#2 config` 现有元数据逐字段比对，**无变化则不产出写计划**（避免每周期空推 config 世代、触发无谓热生效）。
- `reasoning` 档位来源：社区有档位用社区；仅布尔 `true` → 用 vendor `default_reasoning`（按 SDK）；无 → 不显示档位控件（仍默认开推理、用模型默认档）。
- `discover` 错误结构化：`discover_auth_failed` / `discover_bad_url` / `discover_unsupported` / `discover_network`。

## 错误码（结构化，回灌调用方）

`model_auth_failed`(401/403) / `model_rate_limited`(429) / `model_bad_request`(400) / `model_server_error`(5xx) / `model_timeout` / `model_stream_broken` / `model_network_error` / `model_unsupported`（`impl=sdk` 包缺失等）。

## 宿主待补能力

- **定时触发**：宿主按插件声明的周期构造一次 run（调指定命令 / 方法），用于 `#12 sync`；无此能力则退化为「用户手动刷新」。

## 跨插件登记

- **#2 config**：`profile` / `sync` 的写计划按 `#2`「并发语义」执行——读 `+ 2` 投影、只改 `plugins/config/DESIGN.md` 指定的模型元数据字段、整值 `put`；CAS 失败由宿主重跑本方法（有界 3 次），不静默丢字段。
- **#4–10**：`quirks` 声明式字段的规范源在 `#4 vendor-openai`；本插件只解释。
- **#24 secrets**：密钥一律经句柄，明文不进 args / 审计 / 世界。
- **#34 router**：本插件**不做降级链**（选端点归 34）；重试 / 退避 / 限流 / 流断重连**归本插件**（原「模型调用韧性」候选已结清）。
- **#19 / #22 / #33**：`chat` 是它们的唯一模型出口（压缩摘要 / 语义重排 / 图节点）；#20 `embedding` 本地推理、**不调模型**。
- **#49 session-title（版本提升：被提升方，2026-09-19）**：新增方法 **`model.complete`**（非流式单次补全，不发 `model.delta`）——标题生成用它，避免流式分片污染消息流；模型取用户 `#2 config` 所选，不由本插件内置。
