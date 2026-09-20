# #9 `vendor-kimi`（厂商适配）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 9 / `vendor-kimi` |
| 职责 | 厂商适配（连接层）：`sdk` 标识 / 声明式 `quirks` / 模板默认值（预填 URL 与 env 名） |
| 依赖 | pins 无；`<-` 12（读 `sdk` 与 `quirks`）、17（经 #12 `model.vendors` 读模板预填） |
| 成员 | schema |
| 能力类·方法 / 命令 | 无 |
| schema | `schema/vendor.json`（**规范定义见 `#4 vendor-openai`**，七家同形状） |
| 机制 | 预置由 seed 写入；S1 预填后落 `#2 config`；`#12` 按 `sdk` + `quirks` 连（`impl=protocol`） |
| 边界 | 不存 `base_url` / 密钥 / 模型目录 / 参数（归 #2）；不含代码；不存端口 / pid |
| 验收 | 1) 同 #4 形状；2) `quirks` 被 #12 机械解释；3) 换模板不改 #12；4) 不含明文密钥 |
| 状态 | 细节设计（2026-09-19）：`quirks` 冻结；**字段值待核对（W0 建包前核对为显式前置任务，2026-09-20 登记）** |

```jsonc
{ "name": "Kimi",
  "sdk": "kimi",
  "default_base_url": "https://api.moonshot.cn/v1",
  "default_auth_ref_name": "MOONSHOT_API_KEY",
  "default_reasoning": null,                            // 无档位（reasoning_field=null / reasoning_map={}）：#40 不显示档位控件（#12 仍默认开推理、用模型默认档）
  "quirks": {
    "impl": "protocol", "protocol": "openai-chat", "sdk_package": null,
    "auth_style": "bearer", "system_role": "system",
    "reasoning_field": null,                            // 待核对（k2 thinking 是否有开关）
    "reasoning_map": {},
    "reasoning_response_field": "reasoning_content",
    "max_tokens_field": "max_tokens", "models_path": "/models",
    "stream_usage": "final_chunk", "extra_headers": {},
    "note": "OpenAI 兼容（Moonshot）" } }
```

- 本文件仅保留本厂商差异与 JSON；共同模板、字段语义、验收口径见 `plugins/vendor-openai/DESIGN.md`（#4 规范源）（2026-09-20 修订）。
- 规范字段含义见 `#4 vendor-openai`；本文件只填厂商值。**「待核对」项：W0 建包前核对为显式前置任务（2026-09-20 登记）。**
