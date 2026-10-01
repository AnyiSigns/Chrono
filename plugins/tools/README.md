# tools（工具绑定表数据身份）

工具绑定表的**存储本体**：只存数据、不判定、不起进程。
`bindings` 是 `工具名 -> 绑定声明`（目标能力类 / 方法 / argsSchema / caps / 四要素文案）的映射，
由调用方入口 term 读出后随 `bag.tools_bindings` 传给目录装配方。

本包是**数据身份**：只有 `schema`，无服务进程、无 pins、无命令、无 eff。
工具目录装配归 `tool-registry`，整批派发归 `tool-dispatch`。

## 为何保留为数据身份（而非并入 tool-registry）

- 门面能力已收口到 `tool-registry` / `tool-dispatch`：目录装配与整批派发不再经本包，本包无服务、无端口。
- 但**绑定数据契约**仍以本身份为唯一真源：它是世界数据（`add_gen` 的数据世代、可回滚、进重放），
  由装配方入口 term 按字面身份名读投影 `ids.tools.body` 后随 `bag.tools_bindings` 交给目录装配方。
- 把这份数据身份并入 `tool-registry` 只迁移命名、不改任何可观测行为，却会牵动世界 seed、
  投影读取与 `tools_bindings` 契约；故保留为数据身份，能力侧保持转发。

## 身份与数据

- 身份：`tools`
- body：`{ version, bindings }`，两者必填；`bindings` 空对象 = 无绑定。
- 绑定声明形状：`{class, method?, argsSchema, intent, when_to_use, param_semantics, boundaries, caps, idempotent, render?, read?, hidden_params?}`。
- 形态校验归写入端（宿主 v1 不校验身份数据）。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影（`ids.tools.body`）。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 默认 body 预置（可复现）

- `tools/default-body.json`：空绑定表 `{ "version": 1, "bindings": {} }`。
- 写入脚本见 `tools/seed-default-body.mjs`（需宿主在线；同内容命中 put 幂等）。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
