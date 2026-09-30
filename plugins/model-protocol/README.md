# model-protocol（模型 IO 服务）

唯一的模型 IO 服务：HTTP / SSE 传输 + 逐段流式解码 + 调用韧性（重试循环）+ 模型发现（discover）

- 档案同步（profile / sync）+ 厂商模板枚举（vendors）。请求编形 / 方言 / 整包解析与限流退避**决策**
  分别委派给 `msg-dialect` / `throttle` 提供方。

* 能力类：`model`；方法：`chat` / `complete` / `abort` / `vendors` / `discover` / `profile` / `sync`。
* `pins`：`{}`；`needs`：`secrets` / `config` / `throttle` / `msg-dialect`（皆 `mode:one`）。
  经反向帧 `port.call` 调 `secrets.resolve` 取密钥、调 `throttle.*` 取限流 / 退避决策、
  调 `msg-dialect.*` 编请求 / 解析整包 / 内联资产。
* 命令面：无（`commands: []`）；宿主按 `schema` 顶层 `periodic` 直调方法 `sync`。
* 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
* 状态档：`recomputable`（限流状态现落 `throttle` 的 ③ 目录；本插件无本地状态）。
* 服务不读投影、不写世界；世界 / 结果 / args 不取时间随机（重试等待与可选抖动只影响时延）：连接实例与 quirks 由调用方入口 term 装配后随 bag 传入，
  周期路径的投影片段由宿主按 `schema.periodic.reads` 机械注入 bag。

> 拆分说明：逐段流式 SSE 解析**留本插件**（跨插件 `port.call` 是请求 / 响应，不能传流式回调 / `AsyncIterable`），
> HTTP / SSE 传输亦然；无流式回调的纯件（请求编形 `build`、整包解析 `parse-full`、工具编形、鉴权、资产内联、
> quirks / 推理能力表、限流退避状态与决策）分别外置到 `msg-dialect` / `throttle`。

## 调用路径

### `chat(bag)`

从 `bag.config`（`base_url` / `auth_ref` / `model` / `params` / 自定义 `protocol` + 所选厂商 `quirks`）
与 `bag.messages` 出发：

1. `auth_ref` 经反向调用 `secrets.resolve` 解析；**明文只存本进程内存，绝不写入 args / 结果 / 日志 / event**。
   解析结果有效期覆盖整次调用（含重试 / 退避 / 流断重连），重试不重新解析。
2. **资产内联**：把 `messages` 交给反向调用 `msg-dialect.inline-assets`——由该提供方经其
   `host.asset.get` 取二进制附件字节并按协议替换占位符（失败 / 超限降级文本引用）。
3. 经反向调用 `msg-dialect.normalize-quirks` 归一本厂商 quirks；按 `quirks.impl` 分派：
   - `impl=protocol`：`msg-dialect.build` 回 HTTP 请求（url / headers / body），本插件自持
     `http` / SSE 传输与逐段流式解码（三协议 `openai-chat` / `openai-responses` / `anthropic-messages`）；
   - `impl=sdk`：`msg-dialect.build` 回 SDK 参数（`{model, contents, config}`，当前仅 `@google/genai`），
     本插件惰性加载 SDK、发起调用并做流式 / 整包扫描。
4. 请求编形（`messages` 映射 / `temperature` / `max_tokens` 按 `max_tokens_field` / `reasoning` 档位经
   `reasoning_map` 编进 `reasoning_field` / `tools` 编形 / system 角色 / 缓存断点 / 鉴权）全部住 `msg-dialect`；
   工具回灌同样按下述协议口径编形：`assistant` 的中性 `tool_calls: [{id,name,arguments}]` 编成
   openai 的 `{id,type:'function',function:{name,arguments:<json>}}` / anthropic 的 `tool_use` 块；
   `tool` 消息的 `tool_call_id` 在 openai 原样透传、在 anthropic 编成 user 的 `tool_result` 块。
   `tools` 接受**中性声明** `{name, description?, argsSchema?}`，按协议机械编成 function 工具
   （openai-chat / openai-responses 的 `{type:'function', function:{name, description, parameters}}`、
   anthropic-messages 的 `{name, description, input_schema}`）；已带非空 `type` 的协议原生项原样透传，
   缺 `name` 的项丢弃，空列表不写 `tools`。
5. 流式逐段上行 `event(topic:"model.delta", payload:{run, thread, model, protocol, …分片})`——
   `run` / `thread` 自协议帧 `env` 读取。分片含 `text` / `reasoning` / `tool_call` / `usage` / `stop_reason` / `done`。
6. 返回最终值 `{ok, text, reasoning?, tool_calls, usage, model, protocol, stop_reason?}`。
   `usage` 归一为 `{prompt_tokens, completion_tokens, total_tokens}`。

`chat` **非幂等、永不缓存**（`temperature=0` 也不保证逐字节一致）。

### `complete(bag)`

同 `chat` 的连接 / 密钥 / 韧性路径，但**非流式**、**不发 `model.delta`**，返回 `{ok, text, usage}`。
供旁路小补全（如会话标题生成）使用。

### `abort(args)`

`{turn_id}` → 销毁该回合在途 HTTP 请求，返回 `{ok, aborted, turn_id}`。这是取消链路里唯一能真正中止
长推理调用的一层：`chat` / `complete` 收到 `bag.turn_id` 时把请求登记进在途表，`abort` 按 `turn_id`
精确销毁本次请求（不触碰共享适配器或进程级资源），失败归 `model_aborted`（不可重试）。
缺 `turn_id` 或该回合无在途请求 = 幂等 no-op（`aborted:false`），不是错误。请求在成功 / 失败 / 超时 /
中止四条完成路径上都会摘除登记，映射不泄漏。

### `discover(args)`

`{url, auth_ref?}` → `GET {base_url}{models_path}`（缺省 `/models`）+ 鉴权 → 规范化模型 id 列表
（去重、排序、剥 `models/` 前缀，兼容 `data[]` / `models[]` / `items[]` 三种回包）。
结构化错误：`discover_auth_failed` / `discover_bad_url` / `discover_unsupported` / `discover_network`。

### `profile(args)` / `sync(bag)`

拉 models.dev（缺省 `https://models.dev/api.json`，可用 `source_url` 或环境变量 `CHRONO_MODELS_DEV_URL` 覆盖）
→ 只取所选模型 → 产 `config` 身份的**写计划**（整份 body 的 `put` + `add_gen`）。

- 只改 `providers.<vendor>.models.<id>` 的元数据字段：`context_window` / `max_output` / `reasoning` / `modalities`；
  其余字段与未选模型原样不动。
- 社区布尔 `reasoning:true` 展开为该厂商模板的 `default_reasoning` 数组（模板未提供则缺键）；
  `reasoning:false` 或缺失则删键。
- `reasoning_capability` 取所选厂商模板 `quirks.reasoning_replay` 声明（内置在各 `vendor-*` 模板）；
  未声明（自定义厂商 / 协议端点）按实例 `config.providers.<vendor>.protocol` 回落协议默认，未知协议即保守默认。
  无推理档位的模型一律写保守档（不回传、不发思考参数）。
- **写前去重**：与传入的现有 body 逐字段比对，无变化只回 `extern`（不产写计划，避免空推世代）。
- `profile` 入参 `{vendor, ids, config?, vendors?, source_url?}`；`config` 缺省时只回档案值、不产写计划。
- `sync` 由宿主周期直调，对 `config` 内已选模型批量刷新；bag 由 `schema.periodic.reads` 注入。
- 结构化错误：`profile_network` / `profile_bad_source` / `profile_vendor_unknown`。

### `vendors(args)`

枚举调用方传入的厂商模板 body（`{vendors: {...}}` / 数组 / 顶层 `vendor-*` 键），
回 `[{identity, default_base_url, default_auth_ref_name, default_reasoning}]`，供引导页预填。

## 韧性（v1 全做）

| 项       | 口径                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 瞬时重试 | 网络错误 / 5xx / 流断 → 重试上限 `max_retries`；4xx 不重试（429 除外）                                                           |
| 退避     | 指数退避（默认无抖动，保审计可预期）；参数住 `throttle` 的 `schema/throttle.json` 的 `resilience`，经 `throttle.plan` 出延迟     |
| 限流     | 429 尊重 `Retry-After` + 每 provider 令牌桶；状态落 `throttle` 插件 ③ 目录，目录缺失时安全降级为进程内存                         |
| 流断重连 | SSE 断开或未收到终止事件 → 整请求重试；重试前先上行 `{reset:true}`，消费方据此丢弃已累积分片                                     |
| 推理降级 | 4xx 且错误正文指向推理字段（`reasoning`/`thinking`/`signature`/`encrypted`）→ 两段退让：先去回传；仍拒则整套关闭思考（`retention=none`，不发参数也不回传） |
| 字段协商 | 4xx 且正文点名 `max_tokens` / `stream_options` / `tool_choice` / `tools` → 去掉 / 降级该字段后重试；正文给不出线索时按固定梯队（`max_tokens` → `stream_options` → `tool_choice` → `tools`）逐档退让，限次（每次调用最多 3 档）。非 `model_bad_request` 不进入协商 |
| 降级记忆 | 只有**真正跑通**的退让才按 `provider+base_url+model` 记入进程内记忆（会话内后续同类调用不再重复探测，重启 / 换进程重探）；盲试不成功不会永久降级该端点 |
| 超时     | 单次请求超时归 `model_timeout`；方法级等待上限由宿主按 `schema.method_timeouts` 覆盖                                             |
| 取消     | `abort(turn_id)` 销毁该回合在途请求（`model_aborted`，不可重试）；`impl=sdk` 路径由 SDK 内部持有连接，暂不支持（见「已知限制」） |

调用方可在 `bag.resilience` 覆盖本次调用的韧性参数（`max_retries` / `backoff_ms` / `backoff_max_ms` /
`jitter` / `request_timeout_ms` / `token_bucket`）；覆盖随 `throttle.policy` 合并，重试循环本身留本插件
（依赖流 reset 回调），只把「状态 + 决策」外置给 `throttle`。

## 错误码（结构化，作数据回灌调用方）

`model_auth_failed`(401/403) / `model_rate_limited`(429) / `model_bad_request`(400) /
`model_server_error`(5xx) / `model_timeout` / `model_stream_broken` / `model_network_error` /
`model_unsupported`（如 `impl=sdk` 包缺失）/ `model_aborted`（本回合被 `abort` 中止）。失败值形状 `{ok:false, error:{code, message}}`。

## SDK 依赖

`impl=sdk` 的 SDK 包是本插件**自己的 npm 依赖**（`package.json` dependencies + `package-lock.json` 钉版本），
由宿主按清单从依赖缓存恢复；世界只存 `quirks.sdk_package` 这个名字。
`execute/` 对 SDK **惰性 import**；包缺失 / 加载失败 / 包名不受支持 → `model_unsupported`。
当前仅支持 `@google/genai`（`reasoning_field` 允许嵌套点路径，如 `thinkingConfig.thinkingBudget`）。
测试用 `CHRONO_MODEL_SDK_MODULE` 注入伪模块，不触真实网络与真实 SDK。

## schema

`schema/protocol.json` 是本身份的自述 / 数据契约，顶层含宿主消费键：

- `periodic`：`[{method:"sync", every_ms, reads:{config:["ids","config","body"], "vendor-*":["ids","vendor-*","body"]}}]`
  ——宿主机械取投影片段放进 bag，服务不读投影。
- `method_timeouts`：`{"model.chat": <大上限>, "model.complete": <大上限>, "model.abort": 30000}`（流式调用避免被缺省超时截断）。

其余键（各方法 request·result 形状 / `delta_event`）归本插件自用，宿主不解释。
限流 / 退避参数已迁 `throttle` 的 `schema`；厂商 quirks / 推理能力表 / 协议编解码已迁 `msg-dialect`。

## 已知限制

- **`abort` 只覆盖三协议 HTTP 路径**：`impl=sdk`（`@google/genai`）的连接由 SDK 内部持有，`abort` 无法销毁，
  该路径的取消退化为不中止请求（回合仍会以 `cancelled` 收口，只是长推理不会被提前掐断）。
- **流断重试是整请求重试**（v1）：不按 index resume；重试前上行 `{reset:true}`，消费方需据此丢弃已累积文本。
- **`impl=sdk` 仅 `@google/genai`**：新增 SDK 厂商 = 本插件换代。
- **`profile` / `sync` 共享 body 并发为 last-write-wins**（写罕见、单写者，属已知接受口径）。
- 流式要求厂商给出终止标记（`[DONE]` / `response.completed` / `message_stop`），否则按流断处理。
- `models.dev` 的厂商键与本地厂商名不完全一致时靠别名映射（如 `google-genai` → `google`）。

## 运行

```sh
npm test                 # 协议级测试（node --test）
node tools/e2e-smoke.mjs # 宿主装配 E2E（离线：pack → seed → start → 调方法 → stop → verify/replay）
```

## `.worldignore`

排除 `test/` / `tools/` / `node_modules/` / `target/`；`plugin.json` / `package.json` / 锁文件 / `README.md` /
`schema/` / `execute/` 随源码入世。
