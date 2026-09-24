# config（用户模型配置）

用户配置的**单一真源**：厂商连接实例（`base_url` / `auth_ref`）+ 模型目录与元数据 +
参数 / 权限档 / 主题 / 语言 / 侧栏宽度 + 当前选择。
本包是**数据身份**：只有 `schema` 与一个纯读 term，无服务进程、无 pins、无 eff。

## 身份与数据

- 身份：`config`
- body 顶层：`version` / `vendor` / `model` / `params` / `permission` / `ui` / `providers`；
  `required` = `version` / `params` / `permission` / `ui` / `providers`，其余按需缺键。
- 缺键语义：无 `vendor` 键 = 尚未完成首启配置（判「无配置」的判据）。
- `permission` 四档：`auto` / `severe` / `review` / `deny`。
- `ui.theme` 三档：`day` / `night` / `system`；`ui.sidebar_width` 范围 220–420。
- `providers` 键 = 厂商身份名，值为连接实例 + 模型目录；`auth_ref = { kind: "local" | "env", name }`
  **只存引用不存密钥本体**。
- 形状校验归写入端（宿主不校验身份数据）。

## 提供哪些命令

- `config.read`（只读，纯 term，无参）：入口 term 直出投影里的整份 config 身份视图
  （`ctx.ids.config`，含 `active` / `gens` / `body` / `pins` / `refs`）。调用方取 `body` 为配置本体，
  取 `active` 作写 `add_gen` 时的 `expect_active`（两次往返的陈旧读据此条件拒写）。
  - 不触发 eff、不推进链。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入

写者同路：客户端身份整值 `put` + `add_gen`，不设专用写命令。写前用 `config.read` 读回、
只改自己那一处、整值 `put`（读-改-写），不同字段不互相覆盖。跨客户端并发为 last-write-wins。

## 默认 body 预置（可复现）

- `tools/default-body.json`：默认 body（`version: 1`、无 `vendor` / `model`、`params` 保守默认、
  `permission: "review"`、`ui.theme: "system"`、`ui.style: ""`、`ui.sidebar_width: 260`、`providers: {}`）。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。可重复执行。

```
node plugins/config/tools/seed-default-body.mjs --root <宿主根目录>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/`）随源码入世。
