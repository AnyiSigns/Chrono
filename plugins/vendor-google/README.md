# vendor-google（Google 厂商适配模板）

厂商适配（连接层）**纯数据身份**：只声明 `sdk` 标识、声明式 `quirks` 与模板默认值
（预填基址与密钥引用名），不存用户实例、不含代码、不起进程。
用户实例（`base_url` / 密钥 / 模型目录 / 参数）住 `config`，由用户在引导页保存后落 `config`。

## 身份与数据

- 身份：`vendor-google`
- body：`{ name, sdk, default_base_url, default_auth_ref_name, default_reasoning?, quirks }`。
- `quirks` 是纯数据、声明式：模型协议实现只机械解释，不加厂商分支。
- 实现：`sdk`（走官方 SDK 包 `@google/genai`，由模型协议实现捆绑并钉版本）。
- 鉴权：`auth_style` = `header`（`auth_header` = `x-goog-api-key`）。
- 推理：`thinkingConfig.thinkingBudget`，归一档位映射为 low -> 1024、medium -> 8192、high -> 24576。
- 最大输出字段：`maxOutputTokens`。
- 模板默认值只是预填，用户可改；实际连接值以 `config` 为准。
- 可空字段以「缺键或 null」表达；形态校验归写入端（宿主不校验身份数据）。

## 数据来源

下表取值以 2026-09 厂商 API 文档核对（未核实项按规范模板值保留）：

| 项 | 取值 | 核对 |
| --- | --- | --- |
| base_url | `https://generativelanguage.googleapis.com/v1beta` | 2026-09 官方文档确认 |
| auth_ref_name | `GEMINI_API_KEY` | 官方 SDK 环境变量约定（未逐字核对） |
| auth | header `x-goog-api-key` | 2026-09 官方文档确认 |
| system_role | `system` | 官方 SDK 默认（未逐字核对） |
| reasoning_field | `thinkingConfig.thinkingBudget` | 2026-09 官方文档确认（0 关思考、-1 动态；范围随模型） |
| max_tokens_field | `maxOutputTokens` | 2026-09 官方文档确认（SDK 结构字段名） |
| reasoning_response_field | `thought` | 未核实（SDK 以 part 的 `thought` 标记返回思考，非字符串字段；保留规范模板值） |

- Gemini 3 起官方推荐 `thinkingLevel`（minimal / low / medium / high）；`thinkingBudget` 仍被接受，但对 Gemini 3 Pro 可能表现异常。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.vendor-google.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（可重算）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：本厂商模板默认值。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。可重复执行。

```
node plugins/vendor-google/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
