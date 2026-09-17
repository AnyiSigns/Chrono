# 计划 12 · mcp 插件

> 前置：`plan-03`（engine）。
> 口径来源：`docs/agent.md` §4 / §7；`docs/plugins.md`。
> 本计划 = 加 `plugin/mcp.client` 插件；**不改**框架代码。

---

## 目标

接入一个 stdio MCP server：工具进工具表、结果按不可信处理。

## 前置

`plan-03` 验收全绿（`plan-04` 的工具表存在更佳）。

## 本阶段交付

- `plugin/mcp.client`：1 执行件，`implements: ['mcp']`，方法 `list_tools` / `call`。
- 端口 `mcp`（`caps` 默认 **off**，按需开）。
- MCP 工具进工具表（经端点注册）；结果按**不可信**处理。
- `engine.core` 新世代：`pins` 加入 `mcp.client`（若需自动调用）。

## 本阶段口径

- 远程 / HTTP MCP、多服务器编排不在第一版。
- MCP 结果按不可信处理：进上下文前经投影 / 预算，不直接当判据。
- `mcp` 是 `caps` 端口（默认 off），与 `storage.*` 的内部能力不同。

## 出口验收

1. 接一个 stdio MCP server，`list_tools` 取回工具表。
2. 调一次工具，结果进工具表且按不可信路径处理。
3. `caps.mcp` 关闭时调用返回 `no_such_port`。

## 本阶段不做

- 远程 / HTTP MCP、多服务器编排、MCP 工具自动生成市场。

## 范围红线

- 不改框架；MCP 结果不当判据。
- 默认 `caps.mcp = off`，不擅自放宽世界能力表。

## 单次会话可完成

按 `list_tools` → `call` → 工具表接入 → 不可信路径 提交；超尺度即再切。
