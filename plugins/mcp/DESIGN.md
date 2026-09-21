# #37 `mcp`（MCP 适配器 · 双向）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 37 / `mcp`（原 `mcp-client` + `mcp-server` 合并，本轮收敛） |
| 职责 | MCP 适配器，**双向**：**出站**接入外部 MCP 服务器（把它们的工具注册进 #27 的工具目录）；**入站**把本产品能力（工具 / 对话命令）以 MCP 形式暴露给外部 agent |
| 依赖 | pins `{"secrets":"secrets"}`（spawn 前经反向 `port.call` 调 `secrets.resolve` 解析 `env` 里的 `auth_ref` 引用）；**不反向依赖 27**（避免 27 ↔ 37 成环）；`<-` 27（pins：27 派发本插件提供的工具）；入站面由外部连接（无 pins）；**periodic `reads:{"servers":["ids","mcp","body"]}`**（服务器清单住数据世代 body，见下）（2026-09-20 修订） |
| 成员 | execute, schema（**无 `terms/`**——出站发现改为服务方法 `discover` + 宿主 periodic）（2026-09-20 修订） |
| 能力类·方法 | `implements: ["mcp"]`（出站侧作为工具提供者，由 27 按 `pins` 纳入目录），`methods: {"mcp":["describe","invoke","discover"]}`（**类名 = 身份名**，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」；`discover` = 出站发现服务方法；`describe` 只回本插件自述，外部工具清单权威 = 本身份数据世代 body 投影）（2026-09-20 修订） |
| 命令 | 无（**原 `mcp.sync` terms 入口作废**——出站 = 服务方法 `discover` + 宿主 periodic；入站 = `forward` 帧同步回传）（2026-09-20 修订） |
| schema | `schema/mcp.json`（**服务器清单住数据世代 body**：命令 / 参数 / `env`（值可为 `auth_ref` 引用）/ `confirmed` / `trusted`；易变运行态不写回 body；periodic reads 注入）（2026-09-20 修订） |
| 机制 | **出站**：按清单（**条目须 `confirmed:true` 才 spawn**）**自己 spawn** 外部 MCP 服务器进程（stdio 双向），把发现的外部工具写成本身份**数据世代 body 投影**（**不反向 eff 到 27**，否则与 27 成环）；**#14 入口 term** 读出该投影随 bag 传 #27（§1.14），#27 按 `pins` 纳入本适配器、调用时派发到本适配器再转发。**入站**：外部 MCP 请求 → #15 `/p/mcp/*` → **`forward` 帧** → 宿主按本身份声明的命令构造 run → **结果经 forward 的 `result` 同步回传**（#15 → HTTP/SSE 响应给 MCP 客户端；correlation = 请求-响应一对一，无需额外 id）（2026-09-20 修订） |
| 边界 | 不做：工具派发本体（归 27）/ 绕开 27 自建派发 / 判定 / 直写世界 / 密钥本体（走 env 引用） |
| 验收 | 1) 外部 MCP 工具出现在 #27 目录且可被模型调用；2) 本产品能力可被外部 MCP 客户端调用；3) 出站与入站共用同一份清单形状；4) 明文密钥不进世界（`auth_ref` / env 引用）；5) **出站刷新经宿主 periodic（`mcp.discover`）；`tools/list_changed` 只置脏标记、下一拍同步；入站经 `forward` 帧同步回传（不自开端口）**（2026-09-20 修订） |
| 状态 | 已定（本轮合并：`mcp-server` 并入本插件；两个方向共用一个身份）；2026-09-19 补 `terms/` + `mcp.sync` + 宿主周期 / 入站转发触发（D5 / D6）；**（2026-09-20 修订：出站 = discover 方法 + periodic；入站 = forward 同步回传；spawn 须 confirmed）** |

> **两条口径（本轮定案）**
> ① **外部 MCP 服务器进程由本插件自己 spawn，不经 #25 `sandbox`** —— 简单直接；代价是外部 MCP 进程以**宿主权限**运行（已知风险；要隔离则以后改走 #25，或走宿主侧 `start` 包装器那条路）。**2026-09-19 定调：保留例外**（MCP stdio 双向长驻通信与 #25 的一次性 `exec` 模型不匹配）；**2026-09-20 修订：清单条目须 `confirmed:true`（用户在 #17 插件设置面确认）才 spawn**——`auto` 档不静默 spawn 未审查服务器；未确认条目只登记不连接。安全补偿：**#26 `guard` 对 `mcp.*` 工具调用默认 `escalate`**（外部 MCP 服务器可执行任意内容；`confirmed && trusted` 为例外），`auto` 档也 escalate。
> ② **入站只能用 HTTP/SSE**：宿主服务协议 = stdio，插件的 stdin/stdout 已被占用，所以对外不能提供 stdio 型 MCP；**入站面一律经 #15 主端口反代**（`/p/<id>/*`），**插件不自开对外端口**（`#15` 验收「无第二个对外端口」）。（原登记为同类的 `api-face` 已决定不做。）

## 出站进程生命周期（2026-09-19 补，原缺失）

- **启动**：按数据世代 body 清单，对**每个 `confirmed:true`** 条目 spawn 子进程（stdio 双向），握手 MCP `initialize` → `tools/list` → 把工具写成本身份**数据世代 body 投影**（2026-09-20 修订）。
- **密钥引用（2026-09-20 修订）**：服务器条目的 `env` 值可为字符串字面量，或 `auth_ref` 引用 `{auth_ref:{kind:'local'|'env', name}}`。spawn 前本插件经反向 `port.call`（`pins:{"secrets":"secrets"}`）调 `secrets.resolve {auth_ref}`，把明文注入**同名**子进程环境变量；明文不进日志 / 世界 / 计划 / event，解析失败计入该条目连接失败。
- **健康（2026-09-20 修订）**：**外部子服务器的健康用本插件自身 event / 日志表达**（宿主 `service.*` 运维事件只描述本插件服务进程）；失败按 `restart` 策略重启；重启后重新 `tools/list` 刷新投影。
- **工具清单刷新（2026-09-20 修订）**：宿主 periodic（`periodic:[{method:"mcp.discover", every_ms, reads:{"servers":["ids","mcp","body"]}}]`）触发服务方法 `discover` 重拉；收到 `tools/list_changed` 通知只**置脏标记**，下一拍 periodic 同步（**服务无写通道、event 不触发 run**）。**仅当配置 / 工具清单变化（或置脏）才产 `put + add_gen`**；同一状态重复 discover 不产生新世代（易变运行态不写回 body）。
- **断连重连 / 子进程管理（2026-09-20 修订）**：stdio EOF → 视为进程退出 → 宿主按 `restart` 重启；连续失败超 `max` → 隔离该外部服务器条目（从投影摘除，#27 不再派发其工具）。**隔离状态留服务进程内存（③ 可重算），不写回 body**：连接配置变化或本插件服务重启即解除隔离并重试。**本服务维护子进程表；`drain` / 退出时终止全部子进程；宿主 stop / restart 经进程树终止（startWrapper / 进程组）**。

## 出站发现 `discover` 与入站 `forward`（2026-09-20 重写）

- **出站发现 = 服务方法 `discover` + 宿主 periodic**（**原 `terms/` 入口 term / `mcp.sync` 作废**）：
  - 宿主 periodic `periodic:[{method:"mcp.discover", every_ms, reads:{"servers":["ids","mcp","body"]}}]` 触发本服务 `discover`；`discover` 按数据世代 body 清单（`initialize` → `tools/list`）重新发现，把外部工具清单 + `render` + 四要素兜底写成本身份**数据世代 body 投影**（`put(投影 def) + add_gen(mcp)`）；#27 下次 `list` 读新投影即得新工具。
  - **外部工具清单的权威 = 本身份数据世代 body 投影**，由 **#14 入口 term** 读出随 bag 传 #27（§1.14）。
  - `describe` 只回**本插件自述**，不回外部工具清单（外部清单来自投影，见上）。
- **入站 = `forward` 帧同步回传**：外部 MCP 请求到 `/p/mcp/*` → 壳转成宿主入站帧 **`forward {identity:"mcp", command, args}`** → 宿主按本身份声明的命令构造一次 run → **结果经 forward 的 `result` 同步回传**（#15 → HTTP/SSE 响应给 MCP 客户端）；**correlation = 请求-响应一对一，无需额外 id**。
- **服务无写通道**：出站与入站都不直接写世界；出站写投影由宿主落账（`put` + `add_gen`）。（2026-09-20 修订）

## 渲染（外部 MCP 工具，本轮定）

- **工具名命名空间化（2026-09-20 修订）**：外部工具名 = **`mcp.<server>.<tool>`**（与 #28 `read` 等不撞名；#27 `list` 做全局唯一校验）。
- 外部 MCP 工具的 `render` 住**本插件写出的投影声明**；缺省用中性描述符：`{form:"card", label:<工具名>, summary:<args 摘要>, tone:"ghost", detail:{kind:"json"}, live:false}`。
- MCP 的 `outputSchema` / annotations 能映射到 `detail.kind` 就映射（如 `image` 内容 → `{kind:"image"}`、长文本 → `{kind:"code"}`）；映射不出来**一律 `json`**，#18 保证不空白、不报错。
- **描述四要素的兜底（例外口径）**：外部 MCP 工具不一定有四要素 —— `intent` 由 MCP `description` 兜底、`param_semantics` 由 `inputSchema` 各参数的 `description` 兜底、`boundaries` 缺省 `"由外部 MCP 服务器定义"`。**缺项不拒**（硬校验只对内置提供者，见 #27）。

## 跨插件登记

- **#15 ui-shell**：入站面经主端口同源反代（`/p/mcp/*`）；壳转成宿主入站帧 `forward {identity, command, args}`、**宿主构造 run 并把结果经 forward 的 `result` 同步回传**（H8 已落地）（2026-09-20 修订）。
- **宿主周期触发（2026-09-20 修订）**：出站刷新按 periodic `periodic:[{method:"mcp.discover", every_ms, reads:{"servers":["ids","mcp","body"]}}]` 触发服务方法 `discover`；收到 `tools/list_changed` 只**置脏标记**、下一拍同步。**本插件不自开端口**（`#15` 验收「无第二个对外端口」）。
- **#27 tools**：按 `pins` 纳入本适配器；**外部工具清单由 #14 入口 term 读出本身份数据世代 body 投影随 bag 传 #27（§1.14）**；调用经 #27 派发到本适配器再转发（本插件不反向 eff 27）（2026-09-20 修订）。
