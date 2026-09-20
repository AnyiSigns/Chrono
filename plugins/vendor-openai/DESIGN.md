# #4 `vendor-openai`（厂商适配 · 模板规范）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 4 / `vendor-openai` |
| 职责 | 厂商适配（连接层）**规范模板**：`sdk` 标识 / 声明式 `quirks` / 模板默认值（预填 URL 与 env 名） |
| 依赖 | pins 无；`<-` 12（读 `sdk` 与 `quirks`）、17（经 #12 `model.vendors` 读模板预填） |
| 成员 | schema |
| 能力类·方法 / 命令 | 无 |
| schema | `schema/vendor.json`（**#4–#10 七个同形状**，本文件为规范定义处） |
| 机制 | 预置 6 家由 seed 写入；S1 引导页以本插件为**模板**预填 `default_base_url` / `default_auth_ref_name`，用户保存后连接实例落 `#2 config`（本插件不存用户实例）；`#12` 按 `sdk` + `quirks` 连 |
| 边界 | 不存 `base_url` / 密钥 / 模型目录 / 参数（用户实例归 #2）；不含代码；不存端口 / pid |
| 验收 | 1) 7 个同 schema；2) `sdk` / `quirks` 被 #12 机械解释；3) 换模板 / 加厂商不改 #12 代码；4) 不含明文密钥 |
| 状态 | 细节设计（2026-09-19）：`quirks` 声明式字段冻结；**混合**实现（三协议自实现 + 个别厂商 SDK）；本文件为七家规范源 |

## 数据契约 `schema/vendor.json`（七家同形状）

```jsonc
{ "name": "OpenAI",
  "sdk": "openai",                          // 身份 / 方言标识（#12 据此选实现与怪癖）
  "default_base_url": "https://api.openai.com/v1",
  "default_auth_ref_name": "OPENAI_API_KEY",
  "default_reasoning": ["low", "medium", "high"],
  "quirks": {
    "impl": "protocol",                     // "protocol" = 自实现三基础协议 | "sdk" = 官方 SDK 包（随包 ③）
    "protocol": "openai-chat",              // 三基础协议之一（impl=protocol 时）
    "sdk_package": null,                    // impl=sdk 时的 npm 包名（如 "@google/genai"）
    "auth_style": "bearer",                 // bearer（Authorization: Bearer）| query（?key=）| header（x-api-key）
    "auth_header": null,                    // auth_style=header 时的头名；非 header 厂商为 null（bearer 自动用 Authorization）
    "system_role": "developer",             // system | developer
    "reasoning_field": "reasoning_effort",  // 请求里的推理字段；null = 不可传（由模型决定）
    "reasoning_map": { "low": "low", "medium": "medium", "high": "high" },  // 归一档 -> 厂商编码；值类型 string | number | boolean
    "reasoning_response_field": "reasoning_content",  // 响应 / 流里的推理文本字段（可 null）
    "max_tokens_field": "max_completion_tokens",      // 协议枚举：max_tokens | max_completion_tokens | max_output_tokens；impl=sdk 时允许 SDK 结构字段名（如 maxOutputTokens），由适配器解释
    "models_path": "/models",               // discover 的相对路径
    "stream_usage": "final_chunk",          // final_chunk | separate | none（流式里 usage 从哪来）
    "extra_headers": {},                    // 厂商固定头（不含密钥）
    "note": "…"                             // 人读备注（不参与连接）
  } }
```

- **`quirks` 是纯数据、声明式**：`#12` 只机械解释，不加厂商分支（验收 3）。
- **七家同 schema 形状、值类型可不同**：`reasoning_map` 值允许 `string | number | boolean`；`auth_header` 仅 `auth_style=header` 需要（其余为 `null`）；`reasoning_field` 在 `impl=sdk` 时可为嵌套点路径（由 #12 的有界 `impl` 适配器解释）。
- `impl` 混合口径：`protocol` = `#12` 自实现三基础协议（多数厂商）；`sdk` = 引入官方 SDK 包（怪厂商，如 Google）——**由 #12 的包捆绑 SDK 包并钉版本**（`package.json` dependencies / lockfile），**世界只存 `sdk_package` 名、不存 SDK 本体**；`node_modules` 由**通用排除规则**排除、不进世界源码树，宿主物化时从**宿主侧 ③ 依赖缓存**恢复（与 #20 Rust `target/` 同路；不靠本插件用 `.worldignore` 逐条声明）。加载失败 → `model_unsupported`。
- `default_base_url` / `default_auth_ref_name` / `default_reasoning` 只是**预填模板**，用户可改；实际连接值以 `#2 config` 为准。
- `reasoning` 档位来源（`#12` 口径）：社区有档位用社区；仅布尔 `true` → 用本 `default_reasoning`（**按 SDK**）；无 → 不显示档位控件（#12 仍默认开推理、用模型默认）。

## 七家差异（规范源，值待逐个核对）

| # | sdk | impl | protocol | auth_style | reasoning_field | max_tokens_field | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | `openai` | protocol | openai-chat | bearer | `reasoning_effort` | max_completion_tokens | 推理模型用 developer 角色 |
| 5 | `deepseek` | protocol | openai-chat | bearer | `null`（模型决定） | max_tokens | 响应含 `reasoning_content`；待核对 |
| 6 | `dashscope` | protocol | openai-chat | bearer | `enable_thinking` | max_tokens | Qwen3 开关式；待核对 |
| 7 | `google-genai` | **sdk** | —（SDK 托管） | header（`x-goog-api-key`，与 `#7 vendor-google` 2026-09-19 修正同步——原 query 口径作废） | `thinkingConfig.thinkingBudget` | maxOutputTokens | 包 `@google/genai`；**待单独核对** |
| 8 | `zai` | protocol | openai-chat | bearer | `thinking` | max_tokens | 待核对 |
| 9 | `kimi` | protocol | openai-chat | bearer | `null` | max_tokens | 待核对 |
| 10 | `custom` | protocol | 由 `#2 config.protocol` 给 | 由 config 给 | 由 config 给 | 由 config 给 | 无预填、全手填 |
