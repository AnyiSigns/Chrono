# #24 `secrets`（密钥解析 + 本地存储）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 24 / `secrets` |
| 职责 | **唯一密钥面**：密钥本体住**宿主侧用户本地文件**（不进世界）+ 把 `auth_ref` 解析成短时凭据句柄；模型厂商密钥与工具族密钥都走这里 |
| 依赖 | `+` 2（`auth_ref` 引用由调用方入口 term 读 `ctx.ids.config.body` 后经 `resolve` args 传入；本插件服务**不读投影**，D8）；`<-` 12（pins：模型调用取密钥）、29（`tool-shell` 命令执行注入 env）、17（S8 `secrets.list`，D10） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["secrets"]`，`methods: {secrets:["resolve","list"]}` |
| 命令 | 无（密钥写入走宿主入站面 `secrets.put` / `secrets.delete`，见下） |
| schema | `schema/secrets.json`（本地存储路径 / 允许的 `kind` / 句柄有效期） |
| 机制 | 见下「存储 / 引用 / 解析 / 状态」 |
| 边界 | 不做：明文落账 / 明文进世界 / 明文进审计 / 明文进 config 导出 / 工具语义；**不分叉**——模型族与工具族都归本插件 |
| 验收 | 1) 世界、审计、config 导出里都不出现明文；2) 引用缺失报结构化错误且不泄漏值；3) 句柄短时有效、用后即弃；4) 换解析实现不改 12 / 29；5) 本地文件不在世界、不参与哈希 |
| 状态 | 细节设计（2026-09-19）：**密钥本体改住用户本地文件**（原「仅进程环境」口径被取代）；`auth_ref` 支持 `local` / `env` 两种 kind；**补审计脱敏**（`resolve` 结果只回句柄描述，宿主按白名单脱敏 `EffectAudit.result`） |

## 存储（宿主侧用户本地文件，世界排除）

- 位置：宿主侧用户本地文件（如 `state/secrets.local.json`，宿主单点解析路径）——**不进世界、不进账本、不进 config 导出、不参与哈希**。
- 形状：`{ "<name>": "<value>", … }`（name = 用户起的引用名，如 `DEEPSEEK_API_KEY`）。
- **写入 / 删除走宿主入站面**：`secrets.put { name, value }` / `secrets.delete { name }`——**不经 run、不进世界**（与 `asset.put` 同类：宿主直写本地态）。故明文永不出现在 directive / args / 槽 / 审计里。
- `list` 只回 `[{ name, has }]`（**不回值**），供 S8 显「已读到 / 未读到」。

## 引用（`#2 config`）

```jsonc
"auth_ref": { "kind": "local" | "env", "name": "DEEPSEEK_API_KEY" }
```

- `local`（缺省）：从用户本地文件按 `name` 取本体。
- `env`（兼容）：从服务进程环境取本体。
- **config 只存引用名，不存明文**；导出 config 时 `auth_ref` 原样（无明文）。

## 解析

- `resolve(args = { auth_ref })`：`auth_ref` 由调用方入口 term 读 `ctx.ids.config.body` 后经 args 传入（本插件服务**不读投影**，D8）；按 `kind` 取本体 → 返回**短时句柄**（注入子进程 env / 请求头；调用后失效；**不缓存明文**）；本体不回写 bag、不进世界。**句柄有效期覆盖整个调用**（含 #12 的重试 / 退避 / 流断重连），重试不重新 `resolve`（避免审计多条、避免 429 退避期句柄过期）；跨调用不复用。
- **审计脱敏（写死，否则红线自破）**：`resolve` 的 `EffResult.value` **对调用方**仍是短时句柄（调用方需要它注入请求头 / 子进程 env），但 `EffResult` 会被宿主配对成 `EffectAudit`（`host.md` §五 效果 / `protocol.md` §三 audit）——故宿主按「发出者 + `port=secrets` + `method=resolve`」白名单，**把审计里的 `result` 机械替换为 `{ name, kind, has:true }`（不含本体）**。明文只活在调用方进程内存与本机密钥文件，不进 args、不进槽、不进审计正文、不进 config 导出。
- 失败结构化：`secret_missing`（name 不存在）/ `secret_unreadable`（文件不可读）/ `bad_auth_ref`；**不泄漏值、不泄漏文件内容**。

## 跨插件登记

- **宿主待补能力「密钥本地存储面」**：入站 `secrets.put` / `secrets.delete`（宿主直写本地文件，不经 run、不进世界）——现有入站面只有 `asset.*`，需并列新增。
- **宿主待补能力「效果审计脱敏」**：`EffectAudit` 的 `result` 对 `secrets.resolve` 按白名单替换为 `{name,kind,has}`（调用方仍拿到句柄本体）；否则明文经审计落账，破「密钥不进世界 / 不进审计」。
- **#2 config**：`auth_ref.kind` 枚举 `env` → **`local` / `env`**（版本提升，被提升方登记见 `plugins/config/DESIGN.md`）。
- **#17 ui-settings S8（D10）**：由「只显 env 名 + 状态」扩为**可输入密钥**（写入经 `secrets.put`）+ 引用名 + 状态点；**S8 经 `secrets.list` 读「已读到 / 未读到」⇒ #17 新增 `-> 24` pin**（本插件 `<-` 17 对应登记）。
- **#12 / #29**：经 `resolve` 取句柄（#12 注入请求头 / #29 注入子进程 env），明文不出现在任何 args / 审计。`#28` / `#30` / `#31` / `#27` **不 pin 本插件**（无 `auth_ref` 可解；`#30` 零配置、不接需 key 的源）。
