# #37 `mcp`（MCP 适配器 · 双向）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 37 / `mcp`（原 `mcp-client` + `mcp-server` 合并，本轮收敛） |
| 职责 | MCP 适配器，**双向**：**出站**接入外部 MCP 服务器（把它们的工具注册进 #27 的工具目录）；**入站**把本产品能力（工具 / 对话命令）以 MCP 形式暴露给外部 agent |
| 依赖 | pins 无（**不反向依赖 27**，避免 27 ↔ 37 成环）；`<-` 27（pins：27 派发本插件提供的工具）；入站面由外部连接（无 pins） |
| 成员 | execute, **terms**, schema |
| 能力类·方法 | `implements: ["mcp"]`（出站侧作为工具提供者，由 27 按 `pins` 纳入目录），`methods: {"mcp":["describe","invoke"]}`（**类名 = 身份名**，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | **`mcp.sync`**（terms 入口；产出出站投影写计划 + 入站命令+槽写计划；入站由外部 MCP 客户端经 #15 反代直连其端点，出站由 #27 派发） |
| schema | `schema/mcp.json`（外部服务器清单：命令 / 参数 / 环境引用；**出站刷新周期**） |
| 机制 | **出站**：按清单**自己 spawn** 外部 MCP 服务器进程（stdio 双向），把发现的外部工具写成本身份投影数据（**不反向 eff 到 27**，否则与 27 成环）；#27 按 `pins` 纳入本适配器、并读该投影得到工具清单，调用时派发到本适配器再转发。**入站**：把 HTTP/SSE MCP 端点作为 **#15 的子应用反代**（`/p/mcp/*`）暴露（**不自开端口**，保「唯一主端口」；**不能走 stdio** —— stdio 已被宿主服务协议占用），把外部请求翻译成命令 + 写槽。**`terms/`**：`mcp.sync` 入口 term 统一产出「出站投影写计划」与「入站命令+槽写计划」（见下） |
| 边界 | 不做：工具派发本体（归 27）/ 绕开 27 自建派发 / 判定 / 直写世界 / 密钥本体（走 env 引用） |
| 验收 | 1) 外部 MCP 工具出现在 #27 目录且可被模型调用；2) 本产品能力可被外部 MCP 客户端调用；3) 出站与入站共用同一份清单形状；4) 明文密钥不进世界（`auth_ref` / env 引用）；5) **出站刷新经宿主周期触发 / `tools/list_changed`；入站帧经宿主转发触发 `mcp.sync` 跑一次（不自开端口）** |
| 状态 | 已定（本轮合并：`mcp-server` 并入本插件；两个方向共用一个身份）；**2026-09-19 补 `terms/` + `mcp.sync` + 宿主周期 / 入站转发触发（D5 / D6）** |

> **两条口径（本轮定案）**
> ① **外部 MCP 服务器进程由本插件自己 spawn，不经 #25 `sandbox`** —— 简单直接；代价是外部 MCP 进程以**宿主权限**运行（已知风险；要隔离则以后改走 #25，或走宿主侧 `start` 包装器那条路）。**2026-09-19 定调：保留例外**（MCP stdio 双向长驻通信与 #25 的一次性 `exec` 模型不匹配）；安全补偿：**#26 `guard` 对 `mcp` 工具调用判升级弹卡**（外部 MCP 服务器可执行任意内容，归 `severe`/`review` 档，由用户审批放行）。即「外部 MCP 工具调用」在 #26 判据里默认 escalate，除非用户在 `auto` 档。
> ② **入站只能用 HTTP/SSE**：宿主服务协议 = stdio，插件的 stdin/stdout 已被占用，所以对外不能提供 stdio 型 MCP；**入站面一律经 #15 主端口反代**（`/p/<id>/*`），**插件不自开对外端口**（`#15` 验收「无第二个对外端口」）。（原登记为同类的 `api-face` 已决定不做。）

## 出站进程生命周期（2026-09-19 补，原缺失）

- **启动**：按 `schema/mcp.json` 清单，对每个外部服务器 spawn 子进程（stdio 双向），握手 MCP `initialize` → `tools/list` → 把工具写成本身份投影。
- **健康**：宿主按 `health` 声明发 `probe`，本插件转发 MCP `ping`（若服务器支持）或自检 stdio 可写；失败记 `service.start_failed`/`exit`，由宿主 `restart` 策略重启；重启后重新 `tools/list` 刷新投影。
- **工具清单刷新**：周期（住 schema，默认 5min）或收到 `tools/list_changed` 通知时重拉，写新投影世代（数据热生效，#27 下次 `list` 读到新清单）。
- **断连重连**：stdio EOF → 视为进程退出 → 宿主按 `restart` 重启；连续失败超 `max` → `service.restart_exhausted` + 隔离该外部服务器条目（从投影摘除，#27 不再派发其工具）。

## `terms/` 与 `mcp.sync`（D5，本轮补）

- **成员新增 `terms/`**：`mcp.sync` 是入口 term（命令按名调用、不需 pins），统一产出两类写计划：
  - **出站投影写计划**：按 `schema/mcp.json` 重新发现（`initialize` → `tools/list`），把外部工具清单 + `render` + 四要素兜底写成本身份**投影数据**（`put(投影 def) + add_gen(mcp)`）；#27 下次 `list` 读新投影即得新工具。
  - **入站命令+槽写计划**：把外部 MCP 请求翻译成命令（按名）+ 写 `#1 input` 槽，交宿主落账后触发一次 run；**不自开端口、经 #15 主端口反代**（`/p/mcp/*`）。
- **触发方式（D6 / 入站转发）**：
  - **出站刷新 = 宿主周期触发**：周期住 `schema/mcp.json`（默认 5min），宿主按周期构造一次 run 调 `mcp.sync`（出站分支）；收到 `tools/list_changed` 通知亦触发。
  - **入站 = 宿主转发入站帧触发**：外部请求到 `/p/mcp/*` → 壳转成宿主入站帧 `forward {identity:"mcp", command:"mcp.sync", args}` → **宿主按该身份转发到本服务声明的入口 term**（H8 已落地）→ 触发 `mcp.sync`（入站分支）跑一次 → 产命令+槽写计划 → 宿主落账并按槽触发 run。
- **单一入口**：出站发现与入站翻译共用同一个 `mcp.sync` term、共用同一份清单形状；两条分支都只产计划、不直接写世界（服务无写通道）。

## 渲染（外部 MCP 工具，本轮定）

- 外部 MCP 工具的 `render` 住**本插件写出的投影声明**；缺省用中性描述符：`{form:"card", label:<工具名>, summary:<args 摘要>, tone:"ghost", detail:{kind:"json"}, live:false}`。
- MCP 的 `outputSchema` / annotations 能映射到 `detail.kind` 就映射（如 `image` 内容 → `{kind:"image"}`、长文本 → `{kind:"code"}`）；映射不出来**一律 `json`**，#18 保证不空白、不报错。
- **描述四要素的兜底（例外口径）**：外部 MCP 工具不一定有四要素 —— `intent` 由 MCP `description` 兜底、`param_semantics` 由 `inputSchema` 各参数的 `description` 兜底、`boundaries` 缺省 `"由外部 MCP 服务器定义"`。**缺项不拒**（硬校验只对内置提供者，见 #27）。

## 跨插件登记

- **#15 ui-shell**：入站面经主端口同源反代（`/p/mcp/*`）；壳转成宿主入站帧 `forward {identity, command, args}`、**宿主转发到本服务声明的入口 term 触发 `mcp.sync`（入站分支）**（H8 已落地）。
- **宿主周期触发（D6）**：出站刷新按 `schema/mcp.json` 的周期（默认 5min）由宿主构造 run 调 `mcp.sync`；收到 `tools/list_changed` 亦触发。**本插件不自开端口**（`#15` 验收「无第二个对外端口」）。
- **#27 tools**：按 `pins` 纳入本适配器并读本身份投影得到外部工具清单；调用经 #27 派发到本适配器再转发（本插件不反向 eff 27）。
