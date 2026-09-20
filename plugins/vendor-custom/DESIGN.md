# #10 `vendor-custom`（厂商适配）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 10 / `vendor-custom` |
| 职责 | 厂商适配（连接层）：自定义厂商的**三基础协议**入口 / 声明式 `quirks` / 模板默认值 |
| 依赖 | pins 无；`<-` 12（读 `sdk` 与 `quirks`）、17（经 #12 `model.vendors` 读模板预填） |
| 成员 | schema |
| 能力类·方法 / 命令 | 无 |
| schema | `schema/vendor.json`（**规范定义见 `#4 vendor-openai`**，七家同形状） |
| 机制 | **不预置模板**；用户在 S1「自定义」选**三基础协议**（`openai-chat` / `openai-responses` / `anthropic-messages`）并填 URL / env 名，保存后连接实例（含 `protocol`）落 `#2 config`，由 `#12` 按其连接 |
| 边界 | 不存 `base_url` / 密钥 / 模型目录 / 参数（归 #2）；不含代码；不存端口 / pid |
| 验收 | 1) 同 #4 形状；2) 三协议任一可连；3) 换模板不改 #12；4) 不含明文密钥 |
| 状态 | 细节设计（2026-09-19）：`quirks` 冻结；自定义无预填、协议/怪癖全由用户与 config 给 |

```jsonc
{ "name": "Custom",
  "sdk": "custom",
  "default_base_url": "",
  "default_auth_ref_name": "",
  "default_reasoning": null,                            // 无档位（reasoning_field=null / reasoning_map={}）：#40 不显示档位控件
  "quirks": {
    "impl": "protocol", "protocol": null, "sdk_package": null,   // protocol 由 #2 config 给
    "auth_style": "bearer", "auth_header": null,
    "system_role": "system",
    "reasoning_field": null, "reasoning_map": {},
    "reasoning_response_field": null,
    "max_tokens_field": "max_tokens", "models_path": "/models",
    "stream_usage": "final_chunk", "extra_headers": {},
    "note": "无预填；协议 / 连接值以 #2 config 为准" } }
```

- 规范字段含义见 `#4 vendor-openai`；自定义厂商的 `protocol` 与连接值一律以 `#2 config` 为准（本插件只提供三协议枚举与默认怪癖）。
- **自定义厂商的怪癖口径（写死，D15 补）**：`protocol` 与连接值由 `#2 config` 给；**`quirks` 是固定默认值、v1 不经 config 覆盖** ⇒ 自定义厂商被限制在 **`auth_style:'bearer'` + OpenAI-chat 形怪癖**（`reasoning_field:null` / `reasoning_map:{}` / `max_tokens_field:'max_tokens'` / `stream_usage:'final_chunk'`）。需要 `auth_header` / 自定义 `reasoning_field` / `extra_headers` 等非默认怪癖，v1 须另建厂商模板（`protocol` 三选一仍可用，但鉴权头与推理字段固定）。
