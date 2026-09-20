# #3 `short-memory`（短期记忆：会话摘要 L1 + 工作区累积 L2）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 3 / `short-memory` |
| 职责 | **记忆 L1 / L2 的存储本体**：L1 会话摘要（每会话一条，结构化字段，**TTL 24h**）+ L2 工作区累积（每工作区一条，由多次会话摘要去重合并，无 TTL） |
| 依赖 | pins 无；`<-` 13（投影读：注入上下文）、19（计划写回：摘要 / 压缩产物）、23（计划写回：去重合并 / 固化来源 / TTL 清理） |
| 成员 | schema（**数据身份：无进程、无端口、无 eff**） |
| 能力类·方法 | 无 |
| 命令 | 无 |
| schema | `schema/short-memory.json`（单文件平铺 · JSON Schema 白名单子集） |
| 机制 | 见下「包契约 / 数据契约 / 注入契约 / 写入契约 / TTL 与清理 / 跨插件登记」 |
| 边界 | 不做：压缩算法（归 19）/ 去重向量化（归 20、23）/ 检索（归 22）/ 长期 L3 本体（归 21）/ 判定该不该压缩或该记什么（归 33 准则）/ 直接写链 / 起进程 |
| 验收 | 1) 空值下装配正常；2) L1 / L2 结构固定、可回放；3) L1 24h 后由 #23 出删除计划、删除可回放；4) L2 去重合并确定；5) 新会话注入 L2 + 上一会话 L1；6) `covered_upto` 对不上时丢弃并重建、不报错；7) 换 19 / 23 实现不改本插件 |
| 状态 | 细节设计（2026-09-19）：三层记忆口径、结构化字段、24h TTL、压缩落账方式已定 |

> **三层记忆**：**L1 会话摘要（本插件，24h）** / **L2 工作区累积（本插件，无 TTL）** / **L3 长期条目（#21，无 TTL）**。
> **压缩引擎 = #19 `compress`**（`summarize` / `compact` / `extract`）；**维护 = #23 `memory-consolidate`**（去重 / 固化 L2→L3 / `sweep` / agent 顺带清理）。
> 本插件**只存结果、不判定**：写一律来自 19 / 23 的写计划，读一律经 #13 投影。

## 包契约 `plugin.json`

```jsonc
{ "identity": "short-memory",
  "schema": "schema/short-memory.json",
  "implements": [], "methods": {}, "pins": {},
  "start": "",                       // 空 ≡ 无执行件（数据身份）
  "protocol": "1",
  "restart": {}, "health": {},
  "state": "recomputable",
  "members": [{ "kind": "schema", "path": "schema/" }],
  "commands": [] }
```

## 数据契约 `schema/short-memory.json`

结构化字段（非自由文本）——便于机械拼装、选择性注入与去重；白名单子集无 `oneOf` / `$ref`，故字典值形状写在 `description`、由写入端保证（宿主 v1 不校验身份数据）。

```json
{
  "title": "short-memory（L1 会话摘要 + L2 工作区累积）",
  "description": "L1：会话 id -> { summary:{goal,decisions[],facts[],open_questions[],files[],next_steps[]}, covered_upto, at, expires_at }，TTL 24h；L2：工作区 id -> { summary:{goal,decisions[],facts[],open_questions[],files[]}, sources[], at }，无 TTL。缺键 = 该会话 / 工作区无记忆。时间由 bag 传入（服务不取时间）。",
  "type": "object",
  "required": ["version", "sessions", "workspaces"],
  "additionalProperties": true,
  "properties": {
    "version": { "type": "integer" },
    "sessions":   { "type": "object", "additionalProperties": true },
    "workspaces": { "type": "object", "additionalProperties": true }
  }
}
```

- **L1 `summary`**：`goal`（本会话目标）/ `decisions[]`（已定决策）/ `facts[]`（关键事实）/ `open_questions[]`（未决）/ `files[]`（涉及文件）/ `next_steps[]`（下一步）。
- **L2 `summary`**：同 L1 去掉 `next_steps`（工作区层不持有单次会话的下一步）；`sources[]` = 贡献过该累积的会话 id（去重 / 溯源）。
- **`covered_upto`** = 已压缩到的最后一条消息 id（**组装边界**，只影响 #13 组装，#11 的展示消息独立留存、不删）；**`expires_at` = `at` + 24h**（TTL 判据，由 #23 `sweep` 执行）。
- 默认 body：`{ "version": 1, "sessions": {}, "workspaces": {} }`（无需 seed 预置，空即无记忆）。

## 注入契约（#13 `context-window`，只读投影）

对当前会话 `C`、其工作区 `W`，组装时按序注入（各成一条 system 消息，`context-window` 既有「片段各成一条消息」口径）：

1. **L2**：`ctx.ids["short-memory"].body.workspaces[W].summary` → 「工作区记忆」（跨会话项目上下文）。
2. **上一会话 L1**：`W` 中列表序上 `C` 之前的最后一条会话 `P`（`ctx.ids.session.body` 取）→ `sessions[P].summary` → 「上一会话摘要」。
3. **本会话 L1**：`sessions[C].summary` → 「本会话摘要」；并**只注入 `covered_upto` 之后的消息**（其前的轮次不再进组装）。
4. **L3 语义召回**：`#22 memory-retrieval` 的命中条目（#13 已有「记忆引用字段」版本提升）。

- **失效处理（已定）**：`sessions[C].covered_upto` 在 `C` 的消息里对不上（回滚 / 分叉 / 消息被替换）→ **丢弃该条 L1、下次压缩从零重建**；不报错、不阻塞回合。
- **读时 TTL 过滤（写死）**：`#13` 注入前按 bag 传入的 `now` 校验 `expires_at`；**过期 L1 立即不注入**（不等 `#23 sweep`）——sweep 只负责出删除计划（世界清理），TTL 的**可用性**判据必须在读侧，否则 sweep 未跑时过期摘要仍进上下文。
- **75% 自动压缩**：组装完成后按**可用预算 `budget = context_window - max_output - 余量` 的 75%** 判阈值（不是裸 `context_window`）；达阈则**追加一条 system 消息提示 agent 压缩**（不设专门图节点、不自动删消息）。压缩落账后，`covered_upto` 之前的轮次才不再进组装。token 计数 v1 用估算器（规格见 `#13`）；精确 tokenizer 后续可拆小插件（原「token 计数与上下文预算」候选已并入 #13 调配器）。

## 写入契约（19 / 23 的计划，服务无写通道）

```jsonc
{ op:'put',     args:{ body: /* 合并后的 short-memory body */ } },
{ op:'add_gen', args:{ id:'short-memory', payload:{ $n:0 }, pins:{}, sig:{ $n:0 } } }
```

- **L1 写者 = #19**（`summarize` / `compact` 产物）；**L2 写者 = #19 `extract` 产 2–3 条 + #23 去重合并**；**删除 = #23 `sweep`**（过期 L1 / 超容量）。
- 19 / 23 都必须 `+ 3` 读投影做**读-改-写**（不能盲写，否则抹掉其他会话 / 工作区的记忆）。
- **去重**：L1→L2 合并按文本 + 向量余弦（#20）去重；同义合并保留信息更全的一条（#23 口径）。

## TTL 与清理（已定：TTL 兜底 + agent 顺带清理）

- **L1 TTL 24h**：`expires_at` 到期由 **#23 `sweep`** 出删除计划（可回放，非本地定时器）；时间由 bag 传入。
- **L2 / L3 容量兜底**：设上限（参数住 #23 schema，可热改）；超限按策略淘汰（低价值 / 最久未引用）。
- **agent 顺带清理**：agent 每次查看 / 保存 / 更新记忆时，记忆工具（经 #23）**一并返回「过期 / 低价值候选」**，agent 可在同一次调用里决定删 / 合并；**准则住 #33 策略数据**（见下）。
- 绝不永久存：L1 硬 TTL；L2 / L3 有容量上限 + agent 主动清理双保险。

## 跨插件登记

- **#13**：注入契约如上（L2 + 上一会话 L1 + 本会话 L1 + `covered_upto` 边界 + 75% 提示）；`#13` 已有「#22 记忆引用字段」提升，本处再登记「#3 注入契约」。
- **#19 `compress`**：三种压缩（`summarize` / `compact` / `extract`）写本插件 L1 / L2。
- **#23 `memory-consolidate`**：新增 `+ 3`（读投影）、写 L2 合并 / L1 TTL 清理 / L2→L3 固化来源。
- **#21 `memory-store`**：L3 本体；agent 显式保存 + #23 固化两条来源。
- **#33 `loop-policy`**：行为准则（何时压缩 / 记什么 / 忘什么）住其策略数据；无专门压缩节点。
