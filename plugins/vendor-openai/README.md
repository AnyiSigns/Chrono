# vendor-openai（OpenAI 厂商适配模板）

厂商适配（连接层）**纯数据身份**：只声明 `sdk` 标识、声明式 `quirks` 与模板默认值
（预填基址与密钥引用名），不存用户实例、不含代码、不起进程。
用户实例（`base_url` / 密钥 / 模型目录 / 参数）住 `config`，由用户在引导页保存后落 `config`。

## 身份与数据

- 身份：`vendor-openai`
- body：`{ name, sdk, default_base_url, default_auth_ref_name, default_reasoning?, quirks }`。
- `quirks` 是纯数据、声明式：模型协议实现只机械解释，不加厂商分支。
- 实现：`protocol`（自实现三基础协议 openai-chat）。
- 鉴权：`auth_style` = `bearer`（bearer 自动用 Authorization 头）。
- 推理：`reasoning_effort`，归一三档 low / medium / high 原样映射。
- 最大输出字段：`max_completion_tokens`。
- 模板默认值只是预填，用户可改；实际连接值以 `config` 为准。
- 可空字段以「缺键或 null」表达；形态校验归写入端（宿主不校验身份数据）。

## 数据来源

下表取值以 2026-09 厂商 API 文档核对（未核实项按规范模板值保留）：

| 项 | 取值 | 核对 |
| --- | --- | --- |
| base_url | `https://api.openai.com/v1` | 2026-09 官方文档确认 |
| auth_ref_name | `OPENAI_API_KEY` | 官方约定（SDK 默认环境变量名，未逐字核对） |
| auth | bearer | 2026-09 官方文档确认 |
| system_role | `developer` | 2026-09 官方文档确认（推理模型用 developer 角色） |
| reasoning_field | `reasoning_effort` | 2026-09 官方文档确认（支持 none / minimal / low / medium / high / xhigh / max，随模型而异） |
| max_tokens_field | `max_completion_tokens` | 2026-09 官方文档确认（max_tokens 已废弃） |
| reasoning_response_field | `reasoning_content` | 未核实（chat completions 不返回原始推理文本；保留规范模板值） |

- 官方文档支持的推理档位是模型相关超集；本模板按归一三档 low / medium / high 预填。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.vendor-openai.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（可重算）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：本厂商模板默认值。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。可重复执行。

```
node plugins/vendor-openai/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
