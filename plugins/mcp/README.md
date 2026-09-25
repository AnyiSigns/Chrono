# mcp（MCP 适配器 · 双向）

MCP（Model Context Protocol）适配器：**出站**接入外部 MCP 服务器、把它们的工具注册进工具目录；
**入站**把本产品能力以 MCP 形式暴露给外部 agent（v1 = 契约就位、能力面待后续波次接线）。

- 能力类：`mcp`；方法：`describe` / `invoke` / `discover` / `read` / `write`。
- `pins`：`{"secrets":"secrets"}`（spawn 前解析 `env` 里的 `auth_ref` 引用；不反向依赖 `tools`，避免成环）。
- `+`（投影读）：**服务不读投影**——清单已出世界，住本服务自有持久存储（④ `CHRONO_PLUGIN_DATA`），`discover` 读自有存储。
- 状态档：`durable`（④ 不可重算；清单跨代存活、进备份、只按身份消失回收）；`exclusive: ["data"]`。
- 子进程表与易变运行态（`connected` / `failures` / `tool_count` / `isolated` / `isolation` / `last_error`）仍住服务进程内存（③ 可重算）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF / `SIGTERM` / `SIGINT` 即自退出并终止全部外部子进程；
  宽限期到点发 `SIGKILL` 并等真实退出，`process.on('exit')` 再同步硬杀兜底，忽略 SIGTERM 的 server 也不留孤儿）。
- 运行时零 npm 依赖：MCP stdio 客户端自己实现，不引 SDK。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界） | 存储格式版本；回滚不该带；判定不从世界读 |
| `servers[].id` / `command` / `args` / `env` / `cwd` / `confirmed` / `trusted` / `restart` | 运行记录（出世界） | 外部 MCP 服务器清单 = 用户配置；门禁经 `bag.mcp_tools` / `bag.tools` 运行时读 owner，不从世界读 |
| `tools[]`（含 `argsSchema` / `caps`） | 运行记录（出世界） | 发现到的外部工具清单；工具目录与 net 判定经 `bag.mcp_tools` 运行时读 owner，不从世界读 |
| ③ `connected` / `failures` / `tool_count` / `isolated` / `isolation` / `last_error` | ③ 可重算（不进 ④） | 易变运行态，删了可重算 |

**结论**：清单无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def）。

## 出站（主体）

外部 MCP 服务器清单住**本服务自有持久存储**（④ `CHRONO_PLUGIN_DATA/mcp.jsonl`，追加日志），
经 `mcp.read` / `mcp.write` 读写。宿主按 `schema/mcp.json` 顶层 `periodic` 声明每 5 分钟直调本服务
`discover`（**无 `reads`**）；`discover` 读自有存储的 `servers`，重新发现后把**新清单**写回自有存储
（边跑边追加），只回 `extern` 摘要——**不产世界写计划、不占 `seq`、不改 `worldRev`**。

- **只连已确认条目**：服务器条目须 `confirmed:true` 才 spawn；未确认条目只登记、不连接。
- **MCP stdio 传输**：按 MCP 规范以**换行分隔的 JSON-RPC 消息**（每行一条、UTF-8、不得内嵌换行）
  双向通信；**不是** LSP 的 `Content-Length` 分帧。服务器 stderr 作日志。握手顺序：
  `initialize` 请求 → 响应 → `notifications/initialized` 通知 → `tools/list`。
- **工具命名空间化**：外部工具名 = `mcp.<server>.<tool>`（与内置工具不撞名）。
- **四要素兜底**：`intent` 由 MCP `description` 兜底、`param_semantics` 由 `inputSchema` 各参数
  `description` 兜底、`boundaries` 缺省 `"由外部 MCP 服务器定义"`、`when_to_use` 由 `description` 兜底；
  **缺项不拒**（外部工具例外口径）。`render` 为中性描述符
  `{form:"card", label:<工具名>, summary:"{tool}", tone:"ghost", detail:{kind:"json"|"image"}, live:false}`。
- **`tools/list_changed`**：只**置脏标记**（服务无写通道、`event` 不触发 run）；下一拍 `discover`
  才重新拉取并产出新计划。无变化且未置脏时不产写计划（仅 `extern`）。
- **子进程生命周期**：stdio EOF / 退出 → 按条目 `restart` 语义重连重拉（`policy:"never"` 则退出即隔离）；
  连续失败超 `restart.max`（缺省 3）→ **隔离该服务器条目**（其工具从后续清单产出中摘除）。
  健康以本插件 `event`（`topic:"mcp.server"`）+ stderr 日志表达，不占用宿主 `service.*` 事件。
- **易变运行态不写世界**：`connected` / `failures` / `tool_count` / `isolated` / `isolation` / `last_error`
  只留服务进程内存（③ 可重算）；`discover` 仅在**配置 / 工具清单变化（或置脏）**时才产 `put + add_gen`。
- **隔离的解除**：修改该条目的连接配置（触发重连复位），或重启本插件服务（内存态清空）即重新启用。

## `describe(bag)`

只回**本插件自述**，不回外部工具清单（清单权威 = owner 自有存储 `mcp.read`）：

```jsonc
{ "tools": [],
  "adapter": { "identity": "mcp", "dynamic": true, "namespace": "mcp.<server>.<tool>",
               "tool_source": "service:mcp.read",
               "inbound_v1": { "commands": ["mcp.in.ping", "mcp.in.tools_list", "mcp.in.tools_call"],
                               "note": "契约就位、能力面待后续波次接线" } } }
```

## `discover()`

```jsonc
// 读自有存储的 servers → 重新发现 → 有变化写回自有存储（边跑边追加）
// 返回：{$directives:[{kind:"extern",payload:{ok,changed,servers,tools,isolated}}]}
```

- 空清单 / 无变化且未置脏 → 只回 `extern`（不写存储）。
- 清单 body 形状见 `schema/mcp.json`；`write` 的入参为整份 body（或包一层 `{body}`）。

## `read()` / `write(bag)`

- `read`：回整份清单 `{version, servers, tools}`（owner 存储为空时回空体）。
- `write`：整份替换清单（`servers[]` / `tools[]` 必填）；内容未变短路，返回 `{ok, changed}`。

## `invoke(bag)`

```jsonc
// args = { "tool": "mcp.<server>.<tool>", "tool_args": { … } }（也接受 args / arguments）
{ "ok": true,  "result": <MCP tools/call 结果> }
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

结构化错误码：`bad_tool_ref` / `mcp_server_unknown` / `mcp_server_unconfirmed` /
`mcp_server_isolated` / `mcp_tool_unknown` / `mcp_call_failed`。args 形态非法 → 协议 `bad_args`。

> 注：`invoke` 按本服务内存里的服务器表路由（由最近一次 `discover` 建立）。
> 服务重启后到首次 `discover` 之间，`invoke` 回 `mcp_server_unknown`（已知限制）。

## 入站命令（v1 脚手架级）

入站面经 `ui-shell` 主端口同源反代（`/p/mcp/*`），壳转成宿主 `forward {identity:"mcp", command, args}`，
宿主按命令声明构造一次 run 并把结果同步回传。**本插件不自开对外端口。**

| 命令 | 入口 term | v1 能力面 |
| --- | --- | --- |
| `mcp.in.ping` | `terms/mcp.in.ping.json` | 回最小 JSON-RPC 成功信封 |
| `mcp.in.tools_list` | `terms/mcp.in.tools_list.json` | 回空工具清单 |
| `mcp.in.tools_call` | `terms/mcp.in.tools_call.json` | 回结构化 `not_available_in_v1` 错误值 |

命令 `args` 按 MCP JSON-RPC 请求形状 `{jsonrpc, id, method, params}` 透传（`argsSchema` 只做形态门禁）。

> **入站 v1 = 契约就位、能力面待后续波次接线**：本产品能力以 MCP 暴露的完整形态依赖后续波次
> （工具目录等）。当前入口 term 只返回最小能力面；`id` 回带等由壳 / 后续波次接线。

## 清单形状（owner 自有存储）

```jsonc
{
  "version": 1,
  "servers": [
    { "id": "files",                    // 本地唯一 id（工具命名空间的一节）
      "command": "node",                // 可执行（宿主不认识语言）
      "args": ["server.mjs"],           // 参数
      "env": { "K": "V" },              // 额外环境变量（可选）：字符串字面量，或
                                        // { "K": { "auth_ref": { "kind":"local"|"env", "name":"..." } } }
      "cwd": null,                      // 可选工作目录
      "confirmed": true,                // 必须为 true 才 spawn
      "trusted": false,                 // 供工具调用语义门做例外，本插件只透传
      "restart": { "policy": "on-exit", "max": 3 } }
  ],
  "tools": [
    { "name": "mcp.files.read", "server": "files", "tool": "read",
      "intent": "…", "when_to_use": "…", "param_semantics": { "path": "…" },
      "boundaries": "由外部 MCP 服务器定义", "description": "…",
      "argsSchema": { }, "caps": { }, "idempotent": false, "render": { } }
  ]
}
```

- 密钥不进存储明文：服务器 `env` 的值可为 `auth_ref = {kind:'local'|'env', name}` 引用，本体由
  `secrets.resolve` 在 spawn 前解析后注入同名子进程环境变量（明文不进日志 / 存储 / 计划 / event）。
- `tools` 的权威是**owner 自有存储**（`mcp.read`）；调用方（chat 装配 interpret bag）经 `eff` 问 owner 后随 `bag.mcp_tools` 传给 `tools` 插件。

## 存储引擎与落点（自写）

- ④ 落点：`CHRONO_PLUGIN_DATA/mcp.jsonl`，单文件追加日志（每条一次 append + fsync，换行收尾）。
  记录 `{t:'body', run, body}`；启动重放取最后一条 body，末行半写撕裂 / 坏行跳过（fail-open）。
- **边跑边追加**：`discover` 有变化即写一条记录，不攒批；同内容重复写幂等短路；每条记录盖回合 id（`run`）。
- **存量不搬**：存储从空开始，旧世界世代留在链上但不再被读。
- **清理责任**：自写存储；owner 退役时宿主按身份回收删除 `state/data/mcp/`，无需额外清理方法。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（seed → start → 直连 write/discover → ④ 日志 → verify/replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/` / `execute/`）随源码入世。
