# #29 `tool-shell`（命令 / 代码执行工具）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 29 / `tool-shell` |
| 职责 | 沙箱内的**命令与代码执行**工具：一条命令（+ stdout/stderr/退出码），或一段脚本 / 表达式（结构化结果） |
| 依赖 | `->` 24（pins：密钥解析）、25（pins：隔离执行）；`<-` 27（pins：以工具类 `tool-shell` 被本插件派发） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["tool-shell"]`，`methods: {"tool-shell":["describe","invoke"]}`（**类名 = 身份名**，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」；`describe` 回工具名 `shell`） |
| 命令 | 无 |
| schema | `schema/tool-shell.json`（工具描述四要素 + `modes` + 语言白名单 + 默认 `caps`） |
| 机制 | `invoke(bag)` -> 经 25 在隔离环境执行；`mode:"command"` 跑一条命令、`mode:"code"` 跑一段脚本 / 表达式并按结构化结果回；临时产物不落世界 |
| 边界 | 不做：绕过 guard / sandbox / 工具语义判定（归 26）/ 交互式会话（归 31 浏览器）/ **结构化文件读写与路径白名单（归 28 `tool-fs`）** |
| 验收 | 1) 同输入同结果（除环境本身）；2) 命令与代码两种模式共用同一隔离与审计路径；3) 明文密钥不出现在审计；4) 加新执行类工具不改 27 |
| 状态 | 已定（**本轮并入 `tool-code`**：它已撤销——它与本插件重叠，shell 本就能 `node -e` / `python -c`，分两个插件只会多一套沙箱接入与审计面） |

## 数据契约 `schema/tool-shell.json`（2026-09-19 补全）

```jsonc
{ "tool": "shell",
  "intent": "在隔离环境中执行命令或代码片段",            // 描述四要素（缺一 bad_tool_decl）
  "when_to_use": "需要跑构建 / 测试 / 脚本 / 一次性计算时",
  "param_semantics": { "mode": "'command' 跑一条命令；'code' 跑脚本/表达式并回结构化结果", "input": "命令串或代码片段", "language": "mode=code 时的语言（白名单见下）" },
  "boundaries": "不做结构化文件读写（归 read/edit/glob/grep）；不绕过 guard/sandbox",
  "modes": ["command", "code"],
  "languages": ["javascript", "python", "shell"],       // mode=code 支持的语言白名单（v1）
  "default_caps": { "fs": { "read": "workspace", "write": "workspace" }, "net": "none", "cpu_ms": 60000, "mem_mb": 512, "timeout_ms": 120000, "output_max": 1048576, "procs_max": 32 } }   // net 与资源上限码对齐 #25（2026-09-20 修订）
```

- **caps 形状与 #25 一致**（`{fs:{read,write}, net}`，2026-09-19 对齐——原 `"fs":"workspace-rw"` / `"net":"deny"` 字符串形态与 #25 冻结形状不符）：`default_caps` 是**声明上限**，实际执行取「声明 ∩ 当前权限档」（#25 强制）；`timeout_ms` / `mem_mb` / `cpu_ms` 超限由 #25 报 `timeout` / `oom` / `cpu_exceeded`。
- **错误码**（`invoke` 返回）：`fs_denied`（#25 档位拒）/ `net_denied`（网络越档被拒，#25）/ `sandbox_unsupported`（平台无实现）/ `timeout` / `oom` / `cpu_exceeded` / `output_max` / `procs_max` / `nonzero_exit`（命令非 0，结果仍回，带 `exit_code`）/ `code_unsupported_language`（不在白名单）（资源上限码与 #25 对齐，2026-09-20 修订）。
- **密钥注入（2026-09-20 重写）**：`auth_ref` **不由模型工具 args 提供**（工具 `argsSchema` 无该字段——**模型不可自选密钥**）；`bag.auth_ref` 由 **#14 入口 term** 从 **`#2`** 读出（§1.14）；本插件 **`port.call #24 resolve`** 得明文 → 经 **#25 `exec` 的 `env` 字段**下传子进程（宿主端口审计对 `env` 值脱敏 = H19，待落地）；**义务：不写入 args / 结果 / 日志**。句柄有效期覆盖整个调用（含 #12 重试，若适用）。

> **并入后的口径**：`mode` 只区分"输入形态"，不区分隔离等级与审批档——两者都走 25、都过 26、都落同一种审计 def。

## 渲染（`describe.render`，本轮定）

```jsonc
{ "form": "card", "label": "shell",
  "summary": "{input}",                         // 折叠态：显示 agent 输入的命令（裸 {field} = args 字段）；过长由 #18 截断（单行省略）
  "tone": "plain",
  "detail": { "kind": "terminal" },             // 展开态：终端输出（stdout / stderr / 退出码）
  "live": false }                                 // v1 无流式通道（2026-09-20 修订）
```

- **默认收缩**：前面 `shell`，后面 agent 输入的命令；**过长截断**（单行 + 省略号，悬停看全量）。
- **展开 = 终端结果**：等宽 `terminal` 渲染器，stdout / stderr 分色、末尾一行退出码。
- **动态输出（后置登记，2026-09-20 修订）**：v1 = 执行结束后**一次性完整输出**（**#25 `exec` 无流式通道**）；流式增量（命令跑得久时把 stdout 分片经宿主 `event` 发 `tool.delta {call_id, seq, chunk}` → #18 在展开的卡里边跑边追加；`tool.end` 收尾）**后置（登记）**。
- `mode:"code"` 的结构化结果按 `{kind:"json"}` 渲染（同卡、同标签，`detail.kind` 由结果形态定）。
