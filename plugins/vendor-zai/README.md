# vendor-zai（Z.ai 厂商适配模板）

厂商适配（连接层）**纯数据身份**：只声明 `sdk` 标识、声明式 `quirks` 与模板默认值
（预填基址与密钥引用名），不存用户实例、不含代码、不起进程。
用户实例（`base_url` / 密钥 / 模型目录 / 参数）住 `config`，由用户在引导页保存后落 `config`。

## 身份与数据

- 身份：`vendor-zai`
- body：`{ name, sdk, default_base_url, default_auth_ref_name, default_reasoning?, quirks }`。
- `quirks` 是纯数据、声明式：模型协议实现只机械解释，不加厂商分支。
- 实现：`protocol`（自实现三基础协议 openai-chat）。
- 鉴权：`auth_style` = `bearer`（bearer 自动用 Authorization 头）。
- 推理：`reasoning_effort`，归一档位映射为 low -> `low`、medium -> `high`、high -> `high`。
- 最大输出字段：`max_tokens`。
- 模板默认值只是预填，用户可改；实际连接值以 `config` 为准。
- 可空字段以「缺键或 null」表达；形态校验归写入端（宿主不校验身份数据）。

## 数据来源

下表取值以 2026-09 厂商 API 文档核对（未核实项按规范模板值保留）：

| 项 | 取值 | 核对 |
| --- | --- | --- |
| base_url | `https://api.z.ai/api/paas/v4` | 2026-09 官方文档确认（国内为 `https://open.bigmodel.cn/api/paas/v4`） |
| auth_ref_name | `ZAI_API_KEY` | 2026-09 官方文档确认（亦见 `Z_AI_API_KEY`） |
| auth | bearer | 2026-09 官方文档确认 |
| system_role | `system` | 2026-09 官方文档确认 |
| reasoning_field | `reasoning_effort` | 2026-09 官方文档确认（`thinking` 是对象 `{ type: enabled | disabled }`，非布尔；标量档位为 `reasoning_effort`，GLM-5.3 仅 low / high / max） |
| max_tokens_field | `max_tokens` | 2026-09 官方文档确认 |
| reasoning_response_field | `reasoning_content` | 2026-09 官方文档确认 |

- 采用 `reasoning_effort` 是对规范模板原值（`reasoning_field` = `thinking`、布尔映射）的更正：`thinking` 为对象，标量模型无法表达。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.vendor-zai.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（可重算）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：本厂商模板默认值。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。可重复执行。

```
node plugins/vendor-zai/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
