# vendor-custom（Custom 厂商适配模板）

厂商适配（连接层）**纯数据身份**：只声明 `sdk` 标识、声明式 `quirks` 与模板默认值
（预填基址与密钥引用名），不存用户实例、不含代码、不起进程。
用户实例（`base_url` / 密钥 / 模型目录 / 参数）住 `config`，由用户在引导页保存后落 `config`。

## 身份与数据

- 身份：`vendor-custom`
- body：`{ name, sdk, default_base_url, default_auth_ref_name, default_reasoning?, quirks }`。
- `quirks` 是纯数据、声明式：模型协议实现只机械解释，不加厂商分支。
- 实现：`protocol`，具体协议由 `config` 运行时给（三基础协议任一）。
- 鉴权：`auth_style` = `bearer`（bearer 自动用 Authorization 头；具体由 config 给）。
- 推理：无档位（`reasoning_field` 为 null）；协议与怪癖由 `config` 运行时给。
- 最大输出字段：`max_tokens`。
- 模板默认值只是预填，用户可改；实际连接值以 `config` 为准。
- 可空字段以「缺键或 null」表达；形态校验归写入端（宿主不校验身份数据）。

## 数据来源

下表取值以 2026-09 厂商 API 文档核对（未核实项按规范模板值保留）：

| 项 | 取值 | 核对 |
| --- | --- | --- |
| base_url | `""`（空串） | 无预填，用户手填 |
| auth_ref_name | `""`（空串） | 无预填，用户手填 |
| protocol | `null` | 由 config 运行时给 |
| reasoning | 无档位 | 由 config 运行时给 |

- 自定义厂商不预置连接值；三基础协议任一可连，缺省怪癖由协议适配器给。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.vendor-custom.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（可重算）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：自定义厂商的空预填模板（`default_base_url` / `default_auth_ref_name` 为空串）。
- 本包**不提供 seed 脚本**：自定义厂商的连接值 / 协议由用户在 `config` 运行时给，无预置数据世代。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
