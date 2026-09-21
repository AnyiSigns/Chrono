# short-memory（短期记忆：L1 会话摘要 + L2 工作区累积）

记忆 L1 / L2 的**存储本体**：只存结果、不判定、不起进程。
- L1 会话摘要：每会话一条，结构化字段，**TTL 24h**。
- L2 工作区累积：每工作区一条，由多次会话摘要去重合并，无 TTL。
本包是**数据身份**：只有 `schema`，无服务进程、无 pins、无命令、无 eff。

## 身份与数据

- 身份：`short-memory`
- body：`{ version, sessions, workspaces }`，三者必填。
- `sessions[<会话 id>]`：`{ summary: { goal, decisions[], facts[], open_questions[], files[], next_steps[] }, covered_upto, at, expires_at }`；
  `expires_at = at + 24h`，TTL 判据由维护方执行。
- `workspaces[<工作区 id>]`：`{ summary: { goal, decisions[], facts[], open_questions[], files[] }, sources[], at }`；
  `sources[]` = 贡献过该累积的会话 id。
- 缺键 = 该会话 / 工作区无记忆。形态校验归写入端（宿主不校验身份数据）。
- 读侧 TTL：注入前按调用方传入的时间校验 `expires_at`，过期条目立即不注入。

## 提供哪些命令

无命令。数据由写入方的计划落账，读取方按字面身份名读投影。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入

写者同路：客户端 / 服务返回的写计划整值 `put` + `add_gen`。写前必须读回整份 body、
只改目标会话 / 工作区键、整值 `put`（读-改-写），否则会抹掉其他键的记忆。

## 默认 body 预置（可复现）

- `tools/default-body.json`：`{ "version": 1, "sessions": {}, "workspaces": {} }`（空即无记忆）。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。可重复执行。

```
node plugins/short-memory/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/`）随源码入世。
