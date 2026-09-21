# mcp（MCP 适配器 · 双向）

MCP（Model Context Protocol）适配器：**出站**接入外部 MCP 服务器、把它们的工具注册进工具目录；
**入站**把本产品能力以 MCP 形式暴露给外部 agent（v1 = 契约就位、能力面待后续波次接线）。

- 能力类：`mcp`；方法：`describe` / `invoke` / `discover`。
- `pins`：`{"secrets":"secrets"}`（spawn 前解析 `env` 里的 `auth_ref` 引用；不反向依赖 `tools`，避免成环）。
- `+`（投影读）：**服务不读投影**——出站清单由宿主周期 `periodic` 按 schema 声明机械注入 `bag`。
- 状态档：`recomputable`（子进程表住内存，可重算；不落世界）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出并终止全部外部子进程）。
- 运行时零 npm 依赖：MCP stdio 客户端自己实现，不引 SDK。

## 出站（主体）

外部 MCP 服务器清单住**本身份数据世代 body**（投影 `ids.mcp.body.servers`）。宿主按
`schema/mcp.json` 顶层 `periodic` 声明每 5 分钟直调本服务 `discover`，`reads` 把整个 body
注入 `bag.servers`；`discover` 重新发现后把**新 body**（含 `servers` 状态 + `tools` 工具清单）
以**写计划**返回（`put` + `add_gen`），由宿主落账——**服务无写通道**。

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

只回**本插件自述**，不回外部工具清单（清单权威 = 数据世代 body 投影）：

```jsonc
{ "tools": [],
  "adapter": { "identity": "mcp", "dynamic": true, "namespace": "mcp.<server>.<tool>",
               "tool_source": "projection:ids.mcp.body.tools",
               "inbound_v1": { "commands": ["mcp.in.ping", "mcp.in.tools_list", "mcp.in.tools_call"],
                               "note": "契约就位、能力面待后续波次接线" } } }
```

## `discover(bag)`

```jsonc
// bag.servers = 整个 body（宿主 periodic reads:{"servers":["ids","mcp","body"]}）
// 返回：{$directives:[{kind:"write",request:{op:"batch",args:{ops:[put(body),add_gen(mcp)]}}},
//                    {kind:"extern",payload:{ok,changed,servers,tools,isolated}}]}
```

- 空清单 / 无变化且未置脏 → 只回 `extern`（无写计划）。
- `put` 的 body 形状见 `schema/mcp.json`；`add_gen` 的 `payload` / `sig` 用 `{"$n":0}` 指向同批 `put`。

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

## body 形状（数据世代）

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

- 密钥不进世界：服务器 `env` 的值可为 `auth_ref = {kind:'local'|'env', name}` 引用，本体由
  `secrets.resolve` 在 spawn 前解析后注入同名子进程环境变量（明文不进日志 / 世界 / 计划 / event）。
- `tools` 的权威是**本身份数据世代 body 投影**，由工具目录入口 term 读出随 bag 传给 `tools` 插件。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（seed → start → discover → 落账 → verify/replay → 离线投影）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/` / `execute/`）随源码入世。
