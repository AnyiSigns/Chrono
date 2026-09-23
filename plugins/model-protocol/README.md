# model-protocol（模型 IO 服务）

唯一的模型 IO 服务：多 SDK / 三协议 HTTP + SSE（混合实现）+ 调用韧性（重试 / 退避 / 限流 / 流断重连）
+ 模型发现（discover）+ 档案同步（profile / sync）+ 厂商模板枚举（vendors）。

- 能力类：`model`；方法：`chat` / `complete` / `vendors` / `discover` / `profile` / `sync`。
- `pins`：`{"secrets":"secrets"}`（唯一依赖；经反向帧 `port.call` 调 `secrets.resolve` 取密钥）。
- 命令面：无（`commands: []`）；宿主按 `schema` 顶层 `periodic` 直调方法 `sync`。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`（令牌桶等状态落插件 ③ 目录，可重算）。
- 服务不读投影、不写世界；世界 / 结果 / args 不取时间随机（重试等待与可选抖动只影响时延）：连接实例与 quirks 由调用方入口 term 装配后随 bag 传入，
  周期路径的投影片段由宿主按 `schema.periodic.reads` 机械注入 bag。

## 调用路径

### `chat(bag)`

从 `bag.config`（`base_url` / `auth_ref` / `model` / `params` / 自定义 `protocol` + 所选厂商 `quirks`）
与 `bag.messages` 出发：

1. `auth_ref` 经反向调用 `secrets.resolve` 解析；**明文只存本进程内存，绝不写入 args / 结果 / 日志 / event**。
   解析结果有效期覆盖整次调用（含重试 / 退避 / 流断重连），重试不重新解析。
2. 按 `quirks.impl` 分派**有界适配器**：
   - `impl=protocol`：自实现三协议 HTTP + SSE——`openai-chat` / `openai-responses` / `anthropic-messages`；
   - `impl=sdk`：惰性加载 `sdk_package`（当前仅 `@google/genai`）。
3. 编请求：`messages` / `temperature` / `max_tokens`（按 `max_tokens_field`）/ `reasoning`
   （有档位经 `reasoning_map` 编进 `reasoning_field`；无值不传字段，用模型默认）/ `tools`。
   `messages` 里的工具回灌按协议编形：`assistant` 的中性 `tool_calls: [{id,name,arguments}]` 编成
   openai 的 `{id,type:'function',function:{name,arguments:<json>}}` / anthropic 的 `tool_use` 块；
   `tool` 消息的 `tool_call_id` 在 openai 原样透传、在 anthropic 编成 user 的 `tool_result` 块。
   `tools` 接受**中性声明** `{name, description?, argsSchema?}`，按协议机械编成 function 工具
   （openai-chat / openai-responses 的 `{type:'function', function:{name, description, parameters}}`、
   anthropic-messages 的 `{name, description, input_schema}`）；已带非空 `type` 的协议原生项原样透传，
   缺 `name` 的项丢弃，空列表不写 `tools`。
4. 流式逐段上行 `event(topic:"model.delta", payload:{run, thread, model, protocol, …分片})`——
   `run` / `thread` 自协议帧 `env` 读取。分片含 `text` / `reasoning` / `tool_call` / `usage` / `stop_reason` / `done`。
5. 返回最终值 `{ok, text, reasoning?, tool_calls, usage, model, protocol, stop_reason?}`。
   `usage` 归一为 `{prompt_tokens, completion_tokens, total_tokens}`。

`chat` **非幂等、永不缓存**（`temperature=0` 也不保证逐字节一致）。

### `complete(bag)`

同 `chat` 的连接 / 密钥 / 韧性路径，但**非流式**、**不发 `model.delta`**，返回 `{ok, text, usage}`。
供旁路小补全（如会话标题生成）使用。

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
- **写前去重**：与传入的现有 body 逐字段比对，无变化只回 `extern`（不产写计划，避免空推世代）。
- `profile` 入参 `{vendor, ids, config?, vendors?, source_url?}`；`config` 缺省时只回档案值、不产写计划。
- `sync` 由宿主周期直调，对 `config` 内已选模型批量刷新；bag 由 `schema.periodic.reads` 注入。
- 结构化错误：`profile_network` / `profile_bad_source` / `profile_vendor_unknown`。

### `vendors(args)`

枚举调用方传入的厂商模板 body（`{vendors: {...}}` / 数组 / 顶层 `vendor-*` 键），
回 `[{identity, default_base_url, default_auth_ref_name, default_reasoning}]`，供引导页预填。

## 韧性（v1 全做）

| 项 | 口径 |
| --- | --- |
| 瞬时重试 | 网络错误 / 5xx / 流断 → 重试上限 `max_retries`；4xx 不重试（429 除外） |
| 退避 | 指数退避（默认无抖动，保审计可预期）；参数住 `schema/protocol.json` 的 `resilience` |
| 限流 | 429 尊重 `Retry-After` + 每 provider 令牌桶；状态落插件 ③ 目录，目录缺失时安全降级为进程内存 |
| 流断重连 | SSE 断开或未收到终止事件 → 整请求重试；重试前先上行 `{reset:true}`，消费方据此丢弃已累积分片 |
| 超时 | 单次请求超时归 `model_timeout`；方法级等待上限由宿主按 `schema.method_timeouts` 覆盖 |
| 取消 | 协议无 cancel 帧——宿主摘除等待、不杀服务（**无显式取消通道**，见「已知限制」） |

调用方可在 `bag.resilience` 覆盖本次调用的韧性参数（`max_retries` / `backoff_ms` / `backoff_max_ms` /
`jitter` / `request_timeout_ms` / `token_bucket`）。

## 错误码（结构化，作数据回灌调用方）

`model_auth_failed`(401/403) / `model_rate_limited`(429) / `model_bad_request`(400) /
`model_server_error`(5xx) / `model_timeout` / `model_stream_broken` / `model_network_error` /
`model_unsupported`（如 `impl=sdk` 包缺失）。失败值形状 `{ok:false, error:{code, message}}`。

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
- `method_timeouts`：`{"model.chat": <大上限>, "model.complete": <大上限>}`（流式调用避免被缺省超时截断）。

其余键（`resilience` / 各方法 request·result 形状 / `delta_event`）归本插件自用，宿主不解释。

## 已知限制

- **无显式取消通道**：服务协议没有 cancel 帧；宿主取消时只摘除等待、不杀服务，故在途模型调用不会被服务侧中止。
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
