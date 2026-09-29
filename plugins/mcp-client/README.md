# mcp-client（外部 MCP 服务器 stdio 客户端）

外部 MCP 服务器 stdio 客户端：自己实现 MCP 传输（换行分隔的 JSON-RPC 消息、`initialize` 握手、
`tools/list` / `tools/call`）并持有全部外部子进程的连接与生命周期（spawn / 复用 / 重连 / 关闭 /
硬杀兜底）。被上层适配器 `mcp` 经反向 `port.call mcp-client.*` 消费；自身无反向调用、不读投影、
不写世界。

- 身份：`mcp-client`
- 能力类 / 方法：`mcp-client` → `list_tools` / `call_tool` / `close`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`mcp-client.json`）
- `pins`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态；连接与子进程表是可重算运行态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`mcp-client.list_tools`
- 运行时零 npm 依赖：MCP stdio 客户端自己实现，不引 SDK

## 方法

| 方法         | 入参                                                     | 返回                                                     | 行为                                                                     |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `list_tools` | `{server, command, args?, env?, cwd?}`                   | `{ok, tools, reconnected}` / `{ok, error, reconnected}`  | 按 `server` 复用连接（配置变化重连），`initialize` 握手后拉 `tools/list` |
| `call_tool`  | `{server, command, args?, env?, cwd?, tool, arguments?}` | `{ok, result, reconnected}` / `{ok, error, reconnected}` | 确保连接后转发 `tools/call`（结果原样回传）                              |
| `close`      | `{server?}`                                              | `{ok:true, closed}`                                      | 关闭指定 `server`（缺省全部）连接，返回实际关闭数                        |

- 连接按 `server` 键复用；同一 `server` 的连接配置（命令 / 参数 / 环境 / 工作目录）变化即重连。
- `reconnected` 为**字符串**时表示本次为重建连接，值是上一连接意外退出的原因
  （如 `exit(1)` / `spawn_error: …`）；首次建连 / 复用为 `null`。失败 / 隔离 / 重启**策略**不在本插件。
- 传输错误作数据（`{ok:false,error:{code,message}}`）：`bad_config` / `bad_args` /
  `mcp_connect_failed` / `mcp_list_failed` / `mcp_call_failed` / `mcp_client_closing`；不吞、不抛未捕获错误。
- `args` 非对象、`call_tool` 缺 `tool` → 协议 `bad_args`（方法不跑）。

## 传输与生命周期

- **MCP stdio 传输**：spawn 服务器子进程后，双向以**换行分隔的 JSON-RPC 消息**（每行一条、UTF-8、
  不得内嵌换行）通信；**不是** LSP 的 `Content-Length` 分帧。服务器 stderr 作日志。握手顺序：
  `initialize` 请求 → 响应 → `notifications/initialized` 通知；随后 `tools/list` / `tools/call`。
- `notifications/tools/list_changed` 只记日志、不触发重拉：消费方下一次 `list_tools` 一律重拉。
- **子进程退出**：意外退出（stdio EOF / 退出 / spawn 失败）记日志、清连接、留退出原因供下一次
  建连经 `reconnected` 回灌，并上行 `topic:"mcp-client.server"` 的 `exited` 事件（宿主只透传）。
- **关闭**：`close` / drain 先关 stdin（EOF）等服务器自退，宽限期内不退则 `SIGKILL` 并等真实退出；
  `SIGTERM` / `SIGINT` 走优雅停机，`process.on('exit')` 同步硬杀残留子进程——忽略信号的 server
  也不留孤儿。停机期间不再建连，在途建连等落地后再关闭（不泄漏子进程）。
- **env**：`env` 是消费方已解析的追加环境变量（密钥明文只在 spawn 时进子进程）；端口审计按宿主
  口径脱敏反向调用 args 顶层 `env` 值。

## 边界

- 不做：失败计数 / 隔离 / 重启策略（归消费方 `mcp`）/ 工具命名空间化与四要素兜底（归 `mcp`）/
  清单持久化（归 `mcp`）。
- 不写世界、不读投影、无命令面、无反向调用。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/` 随源码入世。
