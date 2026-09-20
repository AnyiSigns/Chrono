# #7 `vendor-google`（厂商适配）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 7 / `vendor-google` |
| 职责 | 厂商适配（连接层）：`sdk` 标识 / 声明式 `quirks` / 模板默认值；**本家走官方 SDK**（`impl=sdk`） |
| 依赖 | pins 无；`<-` 12（读 `sdk` 与 `quirks`）、17（经 #12 `model.vendors` 读模板预填） |
| 成员 | schema |
| 能力类·方法 / 命令 | 无 |
| schema | `schema/vendor.json`（**规范定义见 `#4 vendor-openai`**，七家同形状） |
| 机制 | 预置由 seed 写入；S1 预填后落 `#2 config`；`#12` 见 `impl=sdk` → 加载官方 SDK 包（`sdk_package`；**由 #12 的包捆绑并钉版本**，随包投递住宿主侧 ③） |
| 边界 | 不存 `base_url` / 密钥 / 模型目录 / 参数（归 #2）；不含代码；不存端口 / pid |
| 验收 | 1) 同 #4 形状；2) `impl=sdk` 时 #12 走 SDK 包；3) 换模板不改 #12；4) 不含明文密钥 |
| 状态 | 细节设计（2026-09-19）：`quirks` 冻结；**SDK 适配与字段值需单独核对**（原登记项） |

```jsonc
{ "name": "Google",
  "sdk": "google-genai",
  "default_base_url": "https://generativelanguage.googleapis.com/v1beta",
  "default_auth_ref_name": "GEMINI_API_KEY",
  "default_reasoning": ["low", "medium", "high"],       // 待核对（thinkingBudget 档）
  "quirks": {
    "impl": "sdk", "protocol": null, "sdk_package": "@google/genai",   // 官方 SDK；包名 / 版本由 #12 包捆绑钉定（待核对具体版本）
    "auth_style": "header", "auth_header": "x-goog-api-key",          // 官方 GenAI 用 x-goog-api-key 头（原 query 口径修正）
    "system_role": "system",
    "reasoning_field": "thinkingConfig.thinkingBudget",  // SDK 结构字段（待核对）
    "reasoning_map": { "low": 1024, "medium": 8192, "high": 24576 },   // 待核对
    "reasoning_response_field": "thought",
    "max_tokens_field": "maxOutputTokens", "models_path": "/models",
    "stream_usage": "final_chunk", "extra_headers": {},
    "note": "唯一走 SDK 的预设厂商；三协议自实现不覆盖其原生形态" } }
```

- 规范字段含义见 `#4 vendor-openai`；本文件只填厂商值。**Google 是本轮唯一 `impl=sdk` 的预设厂商**（「混合」口径的 SDK 侧）。
- **SDK 载具（与 #12 对齐）**：`@google/genai` 由 **#12 的包捆绑并钉版本**（`package.json` dependencies / lockfile，随包投递、住宿主侧 ③）；`max_tokens_field: "maxOutputTokens"` 是 **SDK 结构字段名**（非协议枚举），由 #12 的 `impl=sdk` 适配器解释——#12 已写明「`impl=sdk` 时允许 SDK 结构字段名」，本条确认口径一致。
