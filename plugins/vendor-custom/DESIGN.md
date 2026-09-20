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
| 验收 | 1) 同 #4 形状；2) 三协议任一可连（2026-09-20 修订：现成立）；3) 换模板不改 #12；4) 不含明文密钥 |
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

- 本文件仅保留本厂商差异与 JSON；共同模板、字段语义、验收口径见 `plugins/vendor-openai/DESIGN.md`（#4 规范源）（2026-09-20 修订）。
- 规范字段含义见 `#4 vendor-openai`；自定义厂商的 `protocol` 与连接值一律以 `#2 config` 为准（本插件只提供三协议枚举与默认怪癖）。
- **自定义厂商的怪癖口径（D15，2026-09-20 修订）**：**三协议任一可连**：auth / system / max_tokens 缺省由 #12 协议适配器按 `protocol` 给默认（见 #12「三协议默认怪癖」），本插件 `quirks` 仅覆盖差异；`protocol` 以 `#2 config.providers.<id>.protocol` 为准（**双源合并：config 覆盖 quirks，在 #4 schema 注记**）。
- **无档位限制（2026-09-20 修订）**：config 可覆盖 `reasoning_field` / `reasoning_map`（否则该厂商无档位、#40 隐藏按钮）。
