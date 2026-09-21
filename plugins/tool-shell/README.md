# tool-shell（命令 / 代码执行工具）

沙箱内的命令与代码执行工具（**TS**）：单工具 `shell`，两种输入形态 `command` / `code`。
两种形态**共用同一隔离与审计路径**——所有执行经反向帧 `port.call` 到 `sandbox.exec`；
本插件不直接起进程、不读投影、不写世界、不绕过 guard / sandbox。

- 能力类：`tool-shell`；方法：`describe` / `invoke`（类名 = 身份名）。
- 命令：无（`commands: []`）。
- `pins`：`secrets`（`auth_ref` 解析）、`sandbox`（隔离执行）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。运行时零 npm 依赖。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `tool-shell.invoke` 120000，避免长命令被宿主 30s 缺省截断。

## 工具声明（`describe`）

`describe` 一次回报单工具 `shell`（四要素 / `argsSchema` / `caps` / `idempotent` / `modes` / `languages` / `render`）：

```jsonc
{ "name": "shell",
  "intent": "在隔离环境中执行一条命令或一段代码片段。",
  "when_to_use": "需要跑构建 / 测试 / 脚本 / 一次性计算，或临时执行一段代码验证想法时。",
  "param_semantics": { "mode": "…", "input": "…", "language": "…" },
  "boundaries": "不做结构化文件读写（找文件用 glob、读文件用 read、改文件用 edit）；不绕过 guard / sandbox；不做交互式会话。",
  "argsSchema": { "mode": "command|code", "input": "string", "language": "javascript|python|shell" },
  "caps": { "fs": { "read": "workspace", "write": "workspace" }, "net": "none",
            "cpu_ms": 60000, "mem_mb": 512, "timeout_ms": 120000, "output_max": 1048576, "procs_max": 32 },
  "idempotent": false,
  "modes": ["command", "code"],
  "languages": ["javascript", "python", "shell"],
  "render": { "form": "card", "label": "shell", "summary": "{input}", "tone": "plain",
              "detail": { "kind": "terminal" }, "live": false } }
```

- `argsSchema` 只做形态门禁：`input` 必填、`mode` 取 `command` / `code`、`language` 取白名单；`additionalProperties:false`。
- `caps` 是**声明上限**（与 sandbox caps 形状一致，含 `fs.read`）；实际执行取「声明 ∩ 当前权限档」（由 sandbox 强制）。
- 文件可变 / 有副作用，`idempotent:false`（不进宿主结果缓存）。
- 渲染：默认收缩卡片（前 `shell`、后 agent 输入的命令），展开为等宽 `terminal`；`code` 形态的结构化结果按 `json` 形态回。

## `invoke(bag)`

```jsonc
// bag = { tool:"shell", args:{ mode?, input, language? },
//         workspace_root?, tier?, caps?, grant?, sandbox_tiers?, auth_ref? }
{ "ok": true,  "result": { "kind": "terminal" | "json", "exit_code", "stdout", "stderr", "truncated", "duration_ms" } }
{ "ok": false, "error": { "code": "…", "message": "…" }, "result"?: { … } }   // 非零退出 / 资源超限被杀另带 result
```

| 输入形态 | 解释器 | `sandbox.exec` |
| --- | --- | --- |
| `mode:"command"`（缺省） | win32 `cmd.exe /c <input>`；其余 `/bin/sh -c <input>` | `{cmd, args, env?, caps, tier?, workspace_root?, sandbox_tiers?, grant?}` |
| `mode:"code"` + `javascript` | `node -e <input>` | 同上 |
| `mode:"code"` + `python` | `python -c <input>` | 同上 |
| `mode:"code"` + `shell` | 同 `command` | 同上 |

- `mode` 只区分输入形态，不区分隔离等级与审批档。
- `code` 形态：`result.kind = "json"`，`result.value` = stdout 的 JSON 解析（非 JSON 回 `null`）；`command` 形态：`result.kind = "terminal"`。
- `tier` / `workspace_root` / `caps` / `grant` / `sandbox_tiers` **原样透传**给 `sandbox.exec`；未给 `caps` 时用声明缺省。
- `grant` 是批准后的一次性 `caps.grant`，本插件只透传、不解释。

## 错误码

- 输入 / 语言：`bad_args` / `unknown_tool` / `code_unsupported_language`（不在白名单，含 `mode=code` 缺 `language`）。
- 密钥：`bad_auth_ref` / `secret_missing` / `secret_unreadable`（`secrets.resolve` 原码透传）。
- sandbox：`fs_denied` / `net_denied` / `sandbox_unsupported` / `sandbox_setup_failed` / `timeout` / `oom` /
  `cpu_exceeded` / `output_max` / `procs_max` **原样透传**（不吞、不改写）。
- 命令非零退出 → `nonzero_exit`，`result` 仍回带 `exit_code` / `stdout` / `stderr`；
  资源超限被杀 → 原码（`timeout` 等），`result` 仍回。
- 输出截断（`truncated:true`）是**标记非错**（`ok:true`）。
- 反向调用通道失败：`tool_timeout` / `transport_failed`。

## 密钥注入

- 模型工具 args **不含** `auth_ref`（模型不可自选密钥）；`bag.auth_ref` 由调用方入口 term 从 config 读出随 bag 传入。
- 本插件 `port.call secrets.resolve` 取明文，只经 `sandbox.exec` 的 `env` 字段下传子进程（键 = 引用名 `auth_ref.name`）。
- **义务（写死）**：明文不写入 args / 结果 / 日志 / event；解析结果只活在本次调用内存，跨调用不复用。
- 宿主端口审计对反向调用 `args.env` 值脱敏（`{redacted:true, keys:[…]}`）。

## 运行

```sh
npm test                       # 协议级 + 单元测试（node --test）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack secrets/sandbox/tool-shell → seed → start → 直连协议 + 真实反向调用 → stop → verify/replay）
```

E2E 把 tool-shell 的 `port.call` 桥接到**真实 sandbox 二进制**与**真实 secrets 服务**：覆盖两种 mode、
密钥经 `env` 注入、非零退出、deny 档 `fs_denied` 透传与语言白名单。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
