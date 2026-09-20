# #12 `model-protocol`（协议 + 发现 + 档案 + 韧性）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 12 / `model-protocol` |
| 职责 | **唯一的模型 IO 服务**：多 SDK / 三协议 HTTP + SSE（**混合**）+ **调用韧性**（重试 / 退避 / 限流 / 流断重连）+ `discover` + `profile`（定期后台同步）+ `vendors` |
| 依赖 | `->` 24（pins：密钥解析）；`+` 2、4–10（**eff 路径由调用方入口 term（#14 / #17 / #33）读出随 bag 传入（§1.14）；periodic 路径由 `schema.periodic.reads` 注入；服务不读投影**）（2026-09-20 修订）；`<-` 14、17（pins）、19、22、33、34、49 |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["model"]`，`methods: {model:["chat","complete","vendors","discover","profile","sync"]}` |
| 命令 | `plugin.json.commands: []`（无命令面）；**方法 `sync`**（宿主 periodic 直接调；`schema/resilience.json` 顶层 `periodic:[{method:"sync", every_ms, reads:{"config":["ids","config","body"], "vendors":[…]}}]`——reads 声明所需 #2 / #4–10 投影路径）（2026-09-20 修订）——其余命令面在 17（#40 按名调用 `model.profile`） |
| schema | `schema/request.json` / `schema/response.json` / `schema/discover.json` / `schema/profile.json` / `schema/resilience.json`（顶层含 `periodic`（`sync`）与 `method_timeouts`（`model.chat` / `model.complete` 大上限，H17））（2026-09-20 修订） |
| 机制 | 见下「chat / 推理 / 流式与 usage / 韧性 / discover / profile·sync / vendors」 |
| 边界 | 不做：降级链（归 34）/ 落账 / **密钥解析（一律归 24）** / 厂商适配数据（归 4–10；本插件只按 `sdk` / `quirks` 机械解释）/ 直接写世界 / 图拓扑（归 33） |
| 验收 | 1) 各 `impl`（protocol / sdk）真调用；2) 流式不重不漏；3) 韧性生效（瞬时错误重试、429 退避、流断重连、超时）；4) `discover` / `profile` 结构化错误；5) 推理默认开启：有档位传参、无值用模型默认；6) `profile` 只写所选模型且可回放；7) 换实现不改调用方；8) 世界无明文密钥 |
| 状态 | 细节设计（2026-09-19）：**混合实现**（三协议自实现 + 怪厂商 SDK）；**韧性全进 v1**；`quirks` 声明式机械解释；`profile` 定期后台同步（宿主定时触发）；**工具位（tool_calls 编解码）v1 一并做**（原「阶段 3 补」属已废弃的分阶段口径，#33 种子图 `agent.step` v1 即产出 tool_calls，缺它则工具路径不通）。**本轮补**：方法 `sync`（宿主 periodic 直接调，**无需入口 term**、服务不自 eff；`plugin.json.commands: []`）（2026-09-20 修订）；`profile` / `sync` 写前去重 + 按 `#2` 并发语义 |

## chat（唯一模型调用路径）

```
chat(bag)：
  bag.config（连接实例 base_url / auth_ref / 所选 model / params /（自定义）protocol + 所选 vendor 的 quirks）——由调用方入口 term 装配（§1.14）；`auth_ref` 自 bag 取（2026-09-20 修订）
  auth_ref -> eff 24 解析（明文不出现在审计；解析结果仅存本插件进程内存——2026-09-20 修订术语）
  impl = quirks.impl：
    protocol -> 自实现 HTTP + SSE（openai-chat / openai-responses / anthropic-messages）
    sdk      -> 加载 sdk_package（随包投递、宿主侧 ③）
  编请求：messages / temperature / max_tokens（按 max_tokens_field）/ reasoning（按 reasoning_field·map）
  流式逐段发 event(topic="model.delta")，载荷 `{run, thread, …分片}`——run / thread 自协议帧 `env`（H16）读取；返回最终值（含 usage）（2026-09-20 修订）
```

- **推理默认开启（无开关）**：`params.reasoning` 有值 → 经 `reasoning_map` 编进 `reasoning_field`；无值 → 用模型默认档（不传字段）。
- **`chat` 非幂等、永不进宿主结果缓存**（`temperature=0` 也不保证逐字节一致；缓存会掩盖真实漂移）。
- `quirks` **声明式机械解释**（`#4 vendor-openai` 规范）：`impl` / `protocol` / `sdk_package` / `note` / `system_role` / `auth_style` / `auth_header` / `reasoning_field`·`reasoning_map`·`reasoning_response_field` / `max_tokens_field` / `models_path` / `stream_usage` / `extra_headers`（`impl` / `protocol` / `sdk_package` / `note` 为 2026-09-20 修订补入）；**本插件不加厂商分支**——按 `impl` 分派**有界适配器**（`protocol`×3 / `sdk` 一种）；`impl=sdk` 时 `reasoning_field` 允许嵌套点路径（如 Google `thinkingConfig.thinkingBudget`），由该适配器解释，不散落厂商判断。`reasoning_map` 值类型为 `string | number | boolean`（各厂商编码不同）。**v1 `impl=sdk` 仅支持 `@google/genai`（SDK 适配器即 Google 适配器）；新增 SDK 厂商 = 本插件换代**；`impl=sdk` 时鉴权交 SDK 构造参数（`auth_style` / `auth_header` 仅作记录）（2026-09-20 修订）。
- **SDK 载具（v1 口径）**：`impl=sdk` 的 SDK 包（如 `@google/genai`）作为**本插件自己的 npm 依赖**（`package.json` dependencies + lockfile 钉版本）——不依赖其他插件包、不 import 内核，符合 `plugins.md` §三；`node_modules` 由**通用排除规则**排除、**不进世界源码树**，宿主物化时按 `package.json` / lockfile 从**宿主侧 ③ 依赖缓存**恢复（与 #20 的 Rust `target/` 同路）；`sdk_package` 缺失 / 加载失败 → `model_unsupported`。**世界只存 `quirks.sdk_package` 这个名字，不存 SDK 本体。**

## 三协议默认怪癖（2026-09-20 修订）

协议适配器**自带默认**，厂商 `quirks` 与 `vendor-custom` 只覆盖差异、缺省取协议默认：

| protocol | auth | system | max_tokens 字段 |
| --- | --- | --- | --- |
| `openai-chat` | bearer | `system` 角色 | `max_tokens` |
| `openai-responses` | bearer | `system` | `max_output_tokens` |
| `anthropic-messages` | `x-api-key` + `anthropic-version` 头 | 顶层 `system` 字段 | `max_tokens` |

`vendor-custom` 的 anthropic 路径由此可用（不再受 OpenAI-chat 形怪癖限制）。

## complete（非流式单次补全，2026-09-19 补）

```
complete(bag)：同 chat 的连接 / 密钥（eff 24）/ 韧性路径，但 **不流式**：
  bag.config 的 vendor / model / params（同 chat，由调用方入口 term 装配，§1.14）（2026-09-20 修订）
  编请求 -> 单次 HTTP -> 返回 { text, usage }
  不发 event(model.delta)（调用方不期望流）
```

- **给谁用**：`#49 session-title` 的标题生成（短、非流式）；未来其它「旁路小补全」同路。
- **与 `chat` 的差别**：不流式、**不发 `model.delta`**、不进消息流；其余（密钥解析 / 重试 / 退避 / 限流 / 超时 / 取消）**完全同 `chat`**，不新写一套。
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
| 限流 | 429 → 尊重 `Retry-After` + 每 provider 令牌桶（**插件 ③ 目录**（`CHRONO_PLUGIN_STATE`，H4），可重算）（2026-09-20 修订）；超上限结构化失败 |
| 流断重连 | SSE 断开 → **v1 一律整请求重试（受上限）；按 index resume 的厂商扩展后置（须给协议依据）**（2026-09-20 修订） |
| 超时 | 单次调用超时已落地（`--call-timeout-ms` / `CHRONO_CALL_TIMEOUT_MS`）；超时与连接 / 帧 / 进程死亡同归「没执行」 |
| 取消 | 尊重 `cancel{run}`：中止在途、丢弃未完成流 |

## discover / profile·sync / vendors

| 方法 | 输入 | 输出 | 落世界 |
| --- | --- | --- | --- |
| `discover` | args `{url, auth_ref}`（由 #17 入口 term 从 `model.probe` 槽读出后传入）（2026-09-20 修订） | 规范化模型 id 列表（`GET {base_url}{models_path}` + 鉴权） | 否 |
| `profile` | `{vendor, ids}` | 拉 models.dev → 只取所选模型 → 写 `#2 config` 的**写计划**（`context_window` / `max_output` / `reasoning` / `modalities`；落盘前把社区布尔 `true` 展开为该 vendor 的 `default_reasoning` 数组，无则缺键——转换责任在本插件）（2026-09-20 修订） | 是（计划） |
| `sync` | 周期触发 | 同 `profile`（对已选模型批量刷新） | 是（计划） |
| `vendors` | — | 枚举 `vendor-*` 模板，每项 `{identity, default_base_url, default_auth_ref_name, default_reasoning}`（模板清单由 #17 入口 term 读 `#4–10` body 随 args 传入（§1.14），供 #17 S1 预填）（2026-09-20 修订） | 否 |

- **`profile` 入参来源（D8）**：入参 `{vendor, ids}` 由 **#17 `model.profile` 命令的入口 term 读 `#2` 装配**（#17 侧已补 `+ 2`，双侧一致）（2026-09-20 修订），随 args 传入本方法；本服务不读投影（execute-only）。

- **定期后台同步**：`sync` 由**宿主定时触发**（H6 已落地，见下）按 `schema` 顶层 `periodic` 的周期构造一次 run、**直接调方法 `sync`**（2026-09-20 修订）（`host.md` §五 定时触发：调指定命令 / 方法；**无入口 term、服务不自 eff**）；不后台轮询、不写世界（仍走计划）；所需 `#2` 投影片段由宿主按 `schema.periodic.reads` **机械注入 bag**（服务不读投影，D8）。**写前去重**：与 `#2 config` 现有元数据逐字段比对，**无变化则不产出写计划**（避免每周期空推 config 世代、触发无谓热生效）。
- `reasoning` 档位来源：社区有档位用社区；仅布尔 `true` → 用 vendor `default_reasoning`（按 SDK）；无 → 不显示档位控件（仍默认开推理、用模型默认档）。**`profile` / `sync` 落盘前把社区布尔 `true` 展开为该 vendor 的 `default_reasoning` 数组（无则缺键）——转换责任在本插件**（2026-09-20 修订）。
- `discover` 错误结构化：`discover_auth_failed` / `discover_bad_url` / `discover_unsupported` / `discover_network`。

## 错误码（结构化，回灌调用方）

`model_auth_failed`(401/403) / `model_rate_limited`(429) / `model_bad_request`(400) / `model_server_error`(5xx) / `model_timeout` / `model_stream_broken` / `model_network_error` / `model_unsupported`（`impl=sdk` 包缺失等）。

`model_bad_request`（400 类）**不重试**（2026-09-20 修订）。

## 宿主能力（定时触发，H6 已落地）

- **定时触发**：宿主按插件 `schema` 顶层 `periodic` 声明（`{method, every_ms, reads?}`）构造一次 run、直接调方法 `sync`（`model.sync`）（2026-09-20 修订）；`reads` 投影片段机械注入 bag。宿主能力已就位；本插件尚未实现，验收待插件落地。

## 跨插件登记

- **#2 config**：`profile` / `sync` 的写计划按 `#2`「并发语义」执行——**基于 periodic reads 注入快照做读-改-写；v1 共享 body 并发 last-write-wins 为已知限制（写罕见、单写者）**（2026-09-20 修订，删「CAS 有界重试 3 次」的不可达口径）、只改 `plugins/config/DESIGN.md` 指定的模型元数据字段、整值 `put`。
- **#4–10**：`quirks` 声明式字段的规范源在 `#4 vendor-openai`；本插件只解释。
- **#24 secrets**：密钥一律解析后使用（明文仅存调用方进程内存），不进 args / 审计 / 世界。
- **#34 router**：本插件**不做降级链**（选端点归 34）；重试 / 退避 / 限流 / 流断重连**归本插件**（原「模型调用韧性」候选已结清）。
- **#19 / #22 / #33**：`chat` 是它们的唯一模型出口（压缩摘要 / 语义重排 / 图节点）；#20 `embedding` 本地推理、**不调模型**。**#22（2026-09-20 双侧互记）**：`memory-retrieval` 的**多查询 / 语义重排默认关**、其模型调用（若启用）**不参与重放**——重放世界里只复现其检索结果，不重放 `chat` 调用（对侧登记见 `plugins/memory-retrieval/DESIGN.md`）。
- **#49 session-title（版本提升：被提升方，2026-09-19）**：新增方法 **`model.complete`**（非流式单次补全，不发 `model.delta`）——标题生成用它，避免流式分片污染消息流；模型取用户 `#2 config` 所选，不由本插件内置。
- **`model-stub` 夹具**（2026-09-20 修订）：与本插件**同声明 `model`**——**互斥装载**（测试世界替换本插件，非共存）。
- **#14**（2026-09-20 修订）：`chat` / `complete` 的 `bag.config` 装配义务（§1.14）——连接实例 / quirks 由 #14 入口 term 读出随 bag 传入。
- **#33**（2026-09-20 修订）：router 降级判定 pin `router`（见 #34）——`agent.step` 失败后经 `port.call router.select` 选备选端口。
