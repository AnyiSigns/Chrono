# 计划 01 · model 插件链（协议 / 适配器 / 厂商）

> 前置：`plan-00`（框架 + 装配）。
> 口径来源：`docs/agent.md` §4.1 / §4.2 / §4.3 / §10；`docs/plugins.md`。
> 本计划 = 加一批插件；**不改** `boot` / `host` / `assembly` 框架代码。

---

## 目标

加入模型能力，使"调用方只写能力类 `model`、换厂商不改调用方也不改 term"成立，并跑通降级链。

## 前置

`plan-00` 验收全绿（装配层可装载跨 `pins` 依赖的插件）。

## 本阶段交付

- `plugin/protocol.model`：声明（canonical schema + 错误码表）+ term `validate_req`；**0 执行件**。
- `plugin/adapter.model.openai-compat` / `.openai-responses` / `.anthropic`：各 1 执行件，`implements: ['model']`，
  纯映射、不做策略。
- `plugin/adapter.model.stub`：1 执行件，确定性桩，与真适配器同门同审计。
- `plugin/vendor.kilo` / `.deepseek` / `.openai` / `.anthropic`：纯声明 def（端点 / 模型名 / 能力位 / `auth_ref`），
  **0 执行件**；各自 pin 对应适配器。
- `plugin/config.model`：纯声明 def（可用项清单 + 界面声明）。
- `credential/<name>` 声明 def（存在性 / scheme / 标签 / 时间，**无值**）。
- 能力类 `model`（`complete`）；适配器 `needs: ['net']`。
- 降级链（唯一定义在 `agent.md` §10）：限流/超时/失败 → 指数退避重试 → 下一档 vendor 声明 → stub 桩。

## 本阶段口径

- 依赖全是 `pins`：厂商 pin 适配器，适配器 pin 协议；协议换代 → `stale()` 让旧适配器显式失效。
- 校验用 term（`validate_req`），**执行件永远不承担校验**。
- 密钥不进世界：厂商声明只放 `auth_ref: 'cred:…'`；真值由宿主/环境注入，不进 `args` / `EffectAudit` / 日志。
- 端口实现内部的网络**不算 `caps.net`**，由装载期 `needs` 授权。
- 三个适配器 v1 全做，各真跑一次；测试默认厂商走 kilo 免费网关（以 vendor def 形式存在，不硬编码）。

## 出口验收

1. 三协议链各真跑一次，留 `agent.md` §3.4 审计（def + `ref`）。
2. 换 vendor def（kilo → deepseek）不改代码、不改 term。
3. 桩模型与真模型同门，同输入重放逐字节一致。
4. `defs` 与 `EffectAudit` 全文搜不到密钥值，只有 `auth_ref`；凭据解析只出现在宿主侧端口审计。
5. 坏端点 → 自动走降级链，限流/超时/失败**单列**，不计入能力失败。

## 本阶段不做

- UI 对话界面（`plan-02`）、引擎（`plan-03`）。
- 流式、多模态、缓存策略、多 vendor 路由策略。

## 范围红线

- 不改 `boot` / `host` / `assembly`。
- 不把校验或策略写进执行件（适配器只做映射）。
- 密钥不入 `defs` / `args` / 日志。

## 单次会话可完成

按 协议 → 三适配器 → stub → vendor 声明 → `config`/`credential` → 降级链 逐插件提交；
任一子项超尺度即再切。
