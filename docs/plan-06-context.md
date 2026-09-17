# 计划 06 · context 插件（上下文工程）

> 前置：`plan-03`（engine）、`plan-05`（session）。
> 口径来源：`docs/agent.md` §7；`docs/plugins.md`。
> 本计划 = 加 `plugin/context.budget` 插件；**不改**框架代码。

---

## 目标

把世界投影成模型上下文：有预算、有权重×相关度分配、有"喂了什么 / 丢了什么"留痕。

## 前置

`plan-03`、`plan-05` 验收全绿。

## 本阶段交付

- `plugin/context.budget`：1 执行件，`implements: ['context']`。
- 能力类 `context`（`build(view) → context`）——**引擎 `pins` 内部能力，不进 `caps`**。
- term：`select` / `trim`（可热改、可回滚、留痕）。
- 留痕声明：本轮喂入项 / 丢弃项 / 预算占用。
- `pins`：`plugin/storage.view`（投影 / 检索）、`policy/context.*`；（可选）`plugin/memory.fts`。
- `engine.core` 新世代：`pins` 加入 `context.budget`。

## 本阶段口径

- 上下文是对日志的**只读投影**（`base_only`），不产生 write。
- 预算以字符计；分配 = 权重 × 相关度。
- `context` 是引擎 pins 内部能力，世界 term 调不到。
- 投影缓存键 = `worldRev` + 政策哈希；失效由 `worldRev` 变化触发。

## 出口验收

1. 同一世界 + 同一政策 → 同一上下文（逐字节可重放）。
2. 有"喂了什么 / 丢了什么"留痕，可审计。
3. 改 `policy/context.*` → 下一轮生效（本轮锚不变）。

## 本阶段不做

- 向量检索、LLM 融合（`agent.md` §7 第一版不做）。
- 记忆沉淀（`plan-07`）。

## 范围红线

- 不改框架；上下文插件不写世界。
- 不把判定写进执行件。

## 单次会话可完成

按 能力类骨架 → `select`/`trim` term → 留痕 提交；超尺度即再切。
