# tool-shell（命令 / 代码执行工具）

沙箱内的命令与代码执行工具（**TS**）：单工具 `shell`，一个 `action`（`run` / `output` / `kill` / `reset`）与两种输入形态 `command` / `code`。
`run` 默认在**常驻会话**内执行（cd / 环境变量跨调用延续）；`background:true` 起后台任务，用 `action:"output"` 续读、`action:"kill"` 终止。
所有执行经反向帧 `port.call` 到 `sandbox.exec` / `exec_start` / `exec_poll` / `exec_kill` / `session_close`；
本插件不直接起进程、不读投影、不写世界、不绕过 guard / sandbox。

- 能力类：`tool-shell`；方法：`describe` / `invoke`（类名 = 身份名）。
- 命令：无（`commands: []`）。
- `pins`：`secrets`（`auth_ref` 解析）、`sandbox`（隔离执行）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。运行时零 npm 依赖。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `tool-shell.invoke` 130000，避免长命令被宿主 30s 缺省截断；
  反向等待按声明 `timeout_ms` 加余量并 clamp 在宿主预算内（`host 130000 > reverse ≤ 129999 > exec`）。

## 工具声明（`describe`）

`describe` 一次回报单工具 `shell`（四要素 / `argsSchema` / `caps` / `idempotent` / `modes` / `languages` / `render`）：

```jsonc
{
  "name": "shell",
  "intent": "在隔离环境中执行一条命令或一段代码片段。",
  "when_to_use": "需要跑构建 / 测试 / 脚本 / 一次性计算时；命令默认在常驻会话内执行，cd / 环境变量跨调用延续。跑长驻服务用 background:true + action:output。",
  "param_semantics": {
    "action": "…",
    "mode": "…",
    "input": "…",
    "language": "…",
    "description": "…",
    "workdir": "…",
    "timeout_ms": "…",
    "background": "…",
    "fresh": "…",
    "task_id": "…",
    "cursor": "…",
    "wait_ms": "…",
  },
  "boundaries": "不做结构化文件读写（找文件用 glob、读文件用 read、改文件用 edit）；不做 PTY 全屏交互；不绕过 guard / sandbox。",
  "argsSchema": {
    "action?": "run|output|kill|reset",
    "mode?": "command|code",
    "input?": "string",
    "language?": "javascript|python|shell",
    "description?": "string",
    "workdir?": "string",
    "timeout_ms?": "integer",
    "background?": "boolean",
    "fresh?": "boolean",
    "task_id?": "string",
    "cursor?": "integer",
    "wait_ms?": "integer",
  },
  "caps": {
    "fs": { "read": "workspace", "write": "workspace" },
    "net": "none",
    "cpu_ms": 60000,
    "mem_mb": 512,
    "timeout_ms": 120000,
    "output_max": 1048576,
    "procs_max": 32,
  },
  "idempotent": false,
  "modes": ["command", "code"],
  "languages": ["javascript", "python", "shell"],
  "render": {
    "form": "card",
    "label": "shell",
    "summary": "{description}",
    "tone": "plain",
    "detail": { "kind": "terminal" },
    "live": false,
  },
}
```

- `argsSchema` 只做形态门禁：`input` 必填、`mode` 取 `command` / `code`、`language` 取白名单；
  `description` / `workdir` / `timeout_ms` 可选；`additionalProperties:false`。
- `description` 只作展示与审批 / 审计（render 摘要取它），不作为 exec 入参下传。
- `timeout_ms` 只能收紧：`min(请求, 声明 caps.timeout_ms)`，模型抬不高声明上限。
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

| 输入形态                                | 解释器                                                                                   | `sandbox.exec`                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mode:"command"`（缺省）                | 常驻会话内的平台 shell（Windows `-NoExit -Command -`，unix `-s`）；`cd` / env 跨调用延续 | `exec_start`（会话形态）`{session_id, command, session_shell, cwd?, env?, caps, …}` + `exec_poll` 轮询 |
| `mode:"code"` + `javascript` / `python` | 一次性进程 `node -e` / `python3 -c`（`python` 回落）                                     | `exec_start`（一次性）`{cmd, args, env?, cwd?, caps, …}` + `exec_poll` 轮询                            |
| `mode:"code"` + `shell`                 | 同 `command`（会话内）                                                                   | 同 `command`                                                                                           |

- 命令形态统一走**平台原生 shell**：Windows 按 PowerShell、unix 按 POSIX shell；描述文本按当前平台如实生成，不对模型声称跨平台同一语法（避免模型按错误语法猜命令）。`-NoProfile` 保证 Windows 不受用户 profile 影响。解释器在服务启动时一次性探测（存在性，不校验版本）；PowerShell Core 的二进制名跨版本恒为 `pwsh`，故比 7 新的稳定版自动命中，无需改代码。
- **工作目录**：命令的 cwd 取 `bag.workspace_root`，或模型给出的 `workdir`（相对路径以工作目录为基准词法拼接后经 `sandbox.exec` 的 `cwd` 落地）。是否越出工作区由 sandbox 按当前档强制（区内放行、区外须 `full` 读范围），本插件只做词法拼接、不触盘。

- `mode` 只区分输入形态，不区分隔离等级与审批档。
- `code` 形态：`result.kind = "json"`，`result.value` = stdout 的 JSON 解析（非 JSON 回 `null`）；`command` 形态：`result.kind = "terminal"`。
- `run`（前台 / 后台）成功结果的 `result` 另带 `digest`（普通对象，供上下文老化直接渲染、不替换原有字段）：
  `{ cmd, exit, stdout_tail }`——`cmd` 为输入命令，`exit` 为退出码（后台 / 未结束为 `null`），
  `stdout_tail` 为 stdout 尾部（最多 20 行、2000 字符）。确定、有界，不含时间与完整输出。
  `action:"output"` / `"kill"` / `"reset"` 不附 digest。
- `tier` / `workspace_root` / `caps` / `grant` / `sandbox_tiers` **原样透传**给 `sandbox.exec`；未给 `caps` 时用声明缺省。
- `grant` 是批准后的一次性 `caps.grant`，本插件只透传、不解释。

## 会话与后台（`action`）

- `action:"run"`（缺省）：`command` / `code:shell` 在**常驻会话**内执行（会话键 = 调用帧 `thread`，缺省 `run` 再缺省 `default`；按线程隔离）；
  `code:javascript|python` 走一次性进程（不需跨调用状态）。`fresh:true` 先重开会话（清空 cwd / env）。
- **实时输出（写死）**：前台执行 = `exec_start` + 每 300ms `exec_poll`；新输出经 `tool.delta`（带模型 `call_id` / `run` / `thread`，由 `tools` 派发时随 bag 下传）即时下发，
  UI 在工具卡内实时滚动（`render.live:true`）；结束时按「头 + 省略标记 + 尾」组装最终结果。
- `action:"run"` + `background:true`：起后台任务（一次性进程，不套默认超时），立即回 `task_id`。
- `action:"output"`：读后台任务增量输出（`task_id` + 可选 `cursor` / `wait_ms`，游标取上次的 `next_cursor`）。
- `action:"kill"`：杀后台任务（`task_id`）。`action:"reset"`：重开当前线程会话。
- 会话是 sandbox 进程内存活对象：**不落世界、不跨宿主重启**；被淘汰 / 重启时下一条命令由 sandbox 透明重建。
- **输出编码**：Windows PowerShell 形态在命令前拼接 UTF-8 控制台编码前导，避免 5.1 按本机代码页写出中文乱码。

## 错误码

- 输入 / 语言：`bad_args` / `unknown_tool` / `code_unsupported_language`（不在白名单，含 `mode=code` 缺 `language`）。
- 密钥：`bad_auth_ref` / `secret_missing` / `secret_unreadable`（`secrets.resolve` 原码透传）。
- sandbox：`fs_denied` / `net_denied` / `sandbox_unsupported` / `sandbox_setup_failed` / `timeout` / `oom` /
  `cpu_exceeded` / `output_max` / `procs_max` **原样透传**（不吞、不改写）。
- 命令非零退出 → `nonzero_exit`，`result` 仍回带 `exit_code` / `stdout` / `stderr`；
  资源超限被杀 → 原码（`timeout` 等），`result` 仍回。
- 输出截断（`truncated:true`）是**标记非错**（`ok:true`）：结果为「头 … 省略标记 … 尾」，`result.omitted_bytes` 为被丢弃的字节数。
- **输出编码**：Windows PowerShell 形态在命令前拼接 UTF-8 控制台编码前导（`[Console]::OutputEncoding` / `$OutputEncoding`），避免 5.1 按本机代码页写出中文乱码。
- 反向调用通道失败：`tool_timeout` / `transport_failed`。
- 会话 / 任务：`session_busy`（会话内有命令在跑）、`session_died`（会话异常退出且无退出码）、`task_not_found`（任务号不存在或已回收）。

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
