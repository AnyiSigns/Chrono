# #27 `tools`（工具注册与派发）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 27 / `tools` |
| 职责 | 工具注册与派发：维护工具目录，按调用把请求路由到具体工具 |
| 依赖 | `->` 26（pins：先过语义门）；**工具提供者按各自能力类 pin**（每类名一个 pin，见「`tool` 端口契约」）：`tool-fs`→28、`tool-shell`→29、`tool-http`→30、`tool-browser`→31、`mcp`→37、`plugin-admin`→42、`orchestration-admin`→45、`evolve-metrics`→**44**（`record`：user_request 证据，2026-09-19 补——#44 `record` 经本插件暴露为编排工具，#45 流程依赖它；**W6 补绑定，W3 先不带此 pin**，2026-09-20 修订）、`todo`→47、`question`→48、**`session`→11（`subagent.send`/`status` 派发到 #11 `deliver`/投影读）**、**`host` pin（`subagent.resume` / `subagent.terminate` 转交 `host.thread.resume` / `host.thread.terminate`）**（2026-09-20 修订）；记忆工具：`compress`→19、`memory`→21、`retrieval`→22、`memory-maintenance`→23；`+` 2（**tier 经 #33 dispatch bag 传，本插件不自读**，2026-09-20 修订）、37（投影读：MCP 发现的外部工具清单，由调用方入口 term 读后随 bag 传入）、11 / 41（执行根由调用方入口 term 读投影解析后经 bag 传入；**本插件服务不读投影**，D8）；`<-` 33 管道（pins；`#14` v1 静态管道不 pin 本插件，工具只在 `#33` 替换管道后出现） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["tools"]`，`methods: {tools:["list","dispatch"]}` |
| 命令 | 无 |
| schema | `schema/tools.json` |
| 机制 | `list(bag)` 出工具目录（= 本插件 `pins` 的工具提供者 28–31 / 37 / **两个管理面** / **44 `record`** / **47 `todo`** / **48 `question`**，再并入 37 投影里的外部 MCP 工具清单 + **记忆工具**：保存→21 `put` / 检索→22 `retrieval` / 压缩→19 / 清理候选→23；**21 的 `search` 是给 22 / 23 的低层向量检索，不作 agent 工具暴露**）（2026-09-20 修订）；`dispatch(bag)`：**消费 `bag.workspace_root`**（由调用方入口 term 读投影解析后经 #33 传入；#28–31 / 25 只消费 bag，不各自投影读）-> **`port.call` 26 `guard.judge`** 取判定（**兜底：调用方若已先经 #33 `tool.gate` 按 call 判过，则跳过本步、直接消费其 verdict**）-> `allow` 直接派发；`needs_approval` **只返回标记**（**27 不入队、不等审批**；入队由 #33 的 `approval.wait` 调 #32 `enqueue`）；`deny` 返回拒绝 |
| 边界 | 不做：具体工具实现（归 28–31）/ 审批流程与回执（归 32）/ 等待审批（归 33）/ 工具语义判定（归 26）/ 记忆本体与维护（归 19、21–23）/ **管理面的写语义与校验**（归两个管理面各自 + 宿主入世校验） |
| 验收 | 1) 目录与实现解耦（加工具不改 27 代码）；2) deny 不产生任何副作用；3) needs_approval 不阻塞；4) MCP 工具经同一目录派发；5) `bag.workspace_root` 由 #14 入口 term 解析（§1.14）；本插件校验存在性——**缺工作区只对相对路径调用拒绝，绝对路径（区外读写）仍可派发**（四档钳制在 #25）（2026-09-20 修订）；6) 记忆工具经同一目录派发到 19 / 21 / 22 / 23（保存→21、检索→22，不重复暴露 21 `search`）；7) **两个管理面经同一目录派发**，且 `plugin.list` 不出现 `sandbox` 与自己（过滤在其自身、不在本插件）；8) **描述四要素缺一即 `bad_tool_decl`**（该工具不进目录、不派发）；9) **整批 dispatch 并发执行**、结果按 `call_id` 保序、并发上限生效；**v1 批级升级取最严（`any escalate` → 整批走 #33 `approval.wait`，不部分放行；逐项拆批为 post-v1）**；10) 工具卡按 `render` 描述符渲染、无描述符降级 markdown |
| 状态 | **本轮冻结 `tool` 端口契约**（见下）；本插件自身机制（目录 / `dispatch` 管道）随之定稿，验收待 #28 / #30 / #31 展开后回填。历史：补 37 为 pins 被依赖者并去掉「37 反向注册」以免成环，并明确「不等审批」；登记执行根解析职责（见 #41）；登记记忆工具派发（见 `draft-design.md` §1.12）；新增两个管理面工具派发，并把原工具类名改为身份名；**（2026-09-20 修订：绑定表住数据世代 body；guard 主路径归 #33 `tool.gate`；`orchestration.propose` 判 allow；`memory.candidates` 绑 #23；MCP 工具名命名空间化）** |

## 两个管理面工具（本轮登记）

agent 改系统自身的**唯一**路径经本插件派发，两个管理面职责不重叠：

| 工具（**命名空间化**） | 工具类（#27 的 pin 名） | 方法 | 写什么 | 产出 |
| --- | --- | --- | --- | --- |
| #42 `plugin.list` / `plugin.read` / `plugin.validate` / `plugin.write` | `plugin-admin` | `describe` / `invoke` | 插件包 `execute/` 源码 ⇒ **代码换代** | **写计划**（审批闸在执行前拦） |
| #45 `orchestration.list` / `orchestration.read` / `orchestration.validate` / `orchestration.propose` | `orchestration-admin` | `describe` / `invoke` | #33 的图数据 ⇒ **热生效** | **提案条目**（门禁在采纳前拦） |

- **管理面工具名必须命名空间化**（`plugin.*` / `orchestration.*`）：裸 `list` / `read` / `validate` / `write` / `propose` 会与 #28 的 `read` 等撞名，破坏「工具名全局唯一」。

- **本插件只派发、不认识两者的写语义**：校验归各自 + 宿主入世校验，审批归 `26 → 32 → 39`。
- **两者都走同一条 `26` 语义门**：**`orchestration.propose` 判 `allow`**（它只写 #43 台账、不改世界；**人闸在采纳**——`orchestration_change` 由 #33 提案扫描入 #32）；**`plugin.write` 仍 `escalate`**（直接改代码）（**高危判定键 = `(port, 工具名)`**，port = 提供者能力类名；2026-09-20 修订）
  ⇒ 高危写一律入审批队列（`auto` 档直落，复用既有四档）。
- **可见性过滤在 `plugin-admin` 自己身上**（排除 `sandbox` 与自己），本插件不做过滤——
  否则两处名单会漂移。本插件只保证"这两个工具在目录里"。
- **编号**：`plugin-admin` = #42（原有）、`orchestration-admin` = #45（2026-09-19 新增，与 #43 `evolution` / #44 `evolve-metrics` 同批）。
  本插件 `pins` 两者，故建造顺序须后于二者（见 `draft-design.md` §1.11 W3）。

## `tool` 端口契约（本轮冻结）

> **提供者（`describe` / `invoke` 类）**：#28 `tool-fs` / #29 `tool-shell` / #30 `tool-http` / #31 `tool-browser` / #37 `mcp` /
> #42 `plugin-admin` / #45 `orchestration-admin` / #47 `todo` / #48 `question`。
> **绑定提供者（无 `describe` / `invoke`，见下「能力类工具绑定」）**：#11 `session` / #19 `compress` / #21 `memory-store` / #22 `memory-retrieval` / #23 `memory-consolidate` / #44 `evolve-metrics`。
> **工具提供者类名 = 身份名**；其余按 §1.4 注册表（#21 `memory` / #22 `retrieval` / #23 `memory-maintenance`）（`pins` 名→单哈希，若都叫 `tool` 第二个就撞 / `unresolved_cap`）（2026-09-20 修订）。
> describe/invoke 类各两方法：`describe` / `invoke`。**本插件是唯一派发者，契约由本插件冻结**；改动 = 版本提升（双方各记一条，§1.6）。

### `describe(bag) -> 自述`

```jsonc
// 提供者一次回报自己暴露的全部工具
{ "tools": [
  { "name": "read",                    // 对模型暴露的调用名（全局唯一，见「工具名登记」）
    // ↓ 描述四要素：必填、非空，机械校验（见下）；模型可见文本由它们拼装
    "intent": "…",                     // 行为意图：这工具做什么
    "when_to_use": "…",                // 使用时机：什么情形该用它
    "param_semantics": { "path": "…", "offset": "…" },   // 参数语义：逐参数含义 / 单位 / 缺省
    "boundaries": "…",                 // 使用边界：不做什么、该换哪个工具
    "description": "…",                // 模型可见文本（= 四要素拼装；提供者可直给，缺省由 #27 拼）
    "argsSchema": { … },               // JSON Schema 白名单子集（与命令 argsSchema 同一方言，`plugins.md` §二）
    "caps": { "fs": { "read": "workspace", "write": "none" }, "net": false,
              "timeout_ms": 30000, "mem_mb": 1024, "output_max": 1048576, "procs_max": 32 },
    "idempotent": true,                // 只读类 true；写类 / 模型调用 / 有会话类 false
    "render": { … },                   // 可选：工具卡渲染描述符（见下「工具卡渲染」）
    "modes": ["read"] } ] }            // 可选：输入形态分档（#29 command/code、#31 navigate/screenshot）
```

- **描述四要素是硬要求（写死）**：`intent` / `when_to_use` / `param_semantics` / `boundaries` **缺一即拒**（`bad_tool_decl`，该工具不进目录、不派发）；`param_semantics` 的键必须覆盖 `argsSchema` 的必填参数。
  **为什么**：模型选工具靠的是「什么时候用 + 用了会怎样 + 边界在哪」，只给名字与一句摘要会诱发误用；四要素也是**系统提示词里禁写工具标识符**的配套——工具的语义只住在工具描述里，不住提示词里（见 #33「系统提示词」）。
  **例外（外部 MCP 工具）**：四要素由 MCP `description` / `inputSchema.description` 兜底、缺项**不拒**（见 #37）；硬校验只对内置提供者。
- `caps` 形状与 #25 一致（**`{fs:{read,write}, net}` 对象形、含 `fs.read`**；不得按缺少 `fs.read` 的旧形状声明，见 D11）；`idempotent` 驱动宿主结果缓存（见下）。
- **工具名登记（本轮定）**：#28 `read` / `edit` / `glob` / `grep`；#29 `shell`；#30 `websearch` / `webfetch`（**多个免费源 · 零配置 · 无 API key**）；#31 `webbrowser`；#37 外部 MCP 工具（动态，来自投影；工具名**命名空间化 `mcp.<server>.<tool>`**——#37 侧产出即带前缀，`list` 做全局唯一性校验，2026-09-20 修订）；#42 `plugin.list` / `plugin.read` / `plugin.validate` / `plugin.write`、#45 `orchestration.list` / `orchestration.read` / `orchestration.validate` / `orchestration.propose`（**管理面工具名命名空间化**，否则裸 `read` 与 #28 撞名）；**#44 `record`**（编排工具：落 `class:'user_request'` 证据，供 #45 `propose` 引用 `evidence_id`；见 #44「record」）；**线程控制** `subagent.send` / `subagent.status`（派发到 #11 `deliver` / 投影读）、`subagent.resume` / `subagent.terminate`（转交**宿主能力类 `host`**：`host.thread.resume` / `host.thread.terminate`，run 生命周期，见 D7 / `docs/plans/threads-design.md` §三）；**#47 `todo.write` / `todo.read`**；**#48 `question`**；记忆工具（#19 / #21 / #22 / #23，见 §1.12）。**模型只认工具名，不认提供者身份**——换提供者实现不改模型侧。

### `invoke(bag) -> 结果`

```jsonc
// bag 至少带：{ "tool": "read", "args": {…}, "workspace_root": "…", "tier": "…", "caps": {…}, "grant": {…}? }   // tier 经 #33 传（2026-09-20 修订）
{ "ok": true,  "result": {…} }
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

- **`bag.workspace_root`** 由**调用方入口 term 单点解析**（读 `ctx.ids.session.body` 的 `current` → `workspace_id` → `ctx.ids.workspace.body` 的 `path`，见 #41「执行根交接」）后经 #33 传入；本插件服务**不读投影**（D8），只消费 bag，提供者只消费、不各自投影读。
- **`bag.grant`** = 批准后的**一次性 `caps.grant`**（绑定 `call_id`、只放宽本次），**由 #33 在裁决放行时构造、随 bag 传入；本插件只透传给提供者**，提供者再**透传**给 #25 校验，不自行解释（2026-09-20 修订）。
- **服务无写通道**：提供者只回结果 / 错误；要写世界一律回**计划值**，由本插件所在 run 交宿主落账（`host.md` §五 落账）。
- **时间 / 随机不由服务取**；需要时由 bag 传入（同 #23 / #33 口径，保可回放）。

### 能力类工具绑定（第二类工具提供者，本轮定）

工具不必都实现 `describe` / `invoke`：当工具就是某插件**既有能力类方法**的薄封装时，提供者改用**绑定**声明，省掉一层转发。

```jsonc
// 提供者回绑定表：tool name -> 绑定项
{ "bindings": {
  "retrieval": { "class": "retrieval", "method": "search",
                 "argsSchema": {…}, "render": {…}, "caps": {…}, "idempotent": true } } }
```

- **绑定 = `{tool name → {class, method, argsSchema, render?, caps, idempotent}}`**；`method` 缺省 = **投影读**（无服务调用），如 `subagent.status`。**绑定表住本身份数据世代 body**（`bag.tools_bindings` 由 #14 入口 term 读出传入，§1.14；加绑定 = **数据换代热生效**——与 #37 投影同路；`schema/tools.json` 只留身份契约、出生即冻结）（2026-09-20 修订）。
- **绑定工具（本轮登记）**：

  | 工具名 | 提供者 | 能力类·方法 |
  | --- | --- | --- |
  | `subagent.send` | #11 `session` | `session.deliver` |
  | `subagent.status` | #11 `session` | 投影读（`method` 缺省；读取发生在**调用方入口 term**（#14 装配 bag 时读出，§1.14），本插件不读投影）（2026-09-20 修订） |
  | `compress` | #19 `compress` | `compress.compact`（另可绑 `summarize` / `extract`） |
  | `memory` | #21 `memory-store` | `memory.put` / `memory.read` |
  | `retrieval` | #22 `memory-retrieval` | `retrieval.search` |
  | `memory-maintenance` | #23 `memory-consolidate` | `memory-maintenance.*` |
  | `memory.candidates` | #23 `memory-consolidate` | `candidates`（返回过期 / 低价值候选，agent 同回合决定删 / 合并——§1.12 统一口径）（2026-09-20 修订） |
  | `record` | #44 `evolve-metrics` | `evolve-metrics.record` |

- **两类提供者同等对待**：提供者枚举同时含**绑定提供者**与 **describe/invoke 提供者**（#28–31 / 37 / 42 / 45 / 47 / 48 走 describe/invoke）；`list` / `dispatch` 对两者一视同仁——都进目录、都可派发（绑定项在派发时映射为对目标能力类的反向 `port.call`）。
- 绑定项仍须满足**描述四要素**与 `argsSchema` 白名单子集，缺一 `bad_tool_decl`；`caps` 形状与 #25 一致（含 `fs.read`）。

### `tools.list(bag) -> 目录`

目录 = 本插件 `pins` 的工具提供者并集（**describe/invoke 提供者各自 `describe`** + **绑定提供者各自绑定表**，均含其 `caps` / `idempotent` / `argsSchema`）
+ #37 投影里的**外部 MCP 工具**（命名空间化 `mcp.<server>.<tool>`，`list` 做全局唯一性校验）+ **记忆工具**（#19 / #21 / #22 / #23，见 §1.12；#21 的 `search` 不暴露）（2026-09-20 修订）。

- **谁来 eff `list`**：`tools.list` 由 **#33 的 `context.assemble` 节点（或调用方）** eff 后写进 bag / 上下文，模型才看得到工具目录——目录不是模型自动可见的。

### `tools.dispatch(bag) -> 管道（整批 + 并发）`

`bag.calls = [{ call_id, tool, args }]`（模型一轮可产多个 `tool_call`）；返回 `{ results:[{ call_id, ok, result|error }] }`，**按 `call_id` 保序**。

```
0 批级前置（一次）：解析 bag.workspace_root（读 #11 会话 → #41 工作区）；缺失 / 目录已删 -> workspace_missing
   guard 兜底（批级一次）：若 bag 已带 #33 的 verdicts 则跳过；否则 port.call 26 guard.judge（调用描述 + 当前档 + workspace_root）-> allow / escalate / deny
1 逐 call 扇出（整批并发）：对每个 call 并行跑 2–3；**并发上限**住 schema（缺省 4）
2 allow    -> port.call <provider> invoke（附 caps / grant）
   escalate -> 该项回 needs_approval（**本插件只回标记、不入队**；入队由 #33 的 `approval.wait` 调 #32 `approval.enqueue`）
   deny     -> 该项回 denied（不产生任何副作用）
```

- **主路径与兜底（2026-09-20 修订）**：guard 主路径 = **#33 `tool.gate` 按 call 逐项**；本插件**兜底、批级一次**（若 bag 已带 #33 的 verdicts 则跳过）；本插件是**服务**，对提供者的调用走**反向帧 `port.call`**（`docs/protocol.md` §2.4）。

- **写计划冒泡（D3）**：`results[]` 里若含提供者返回的**计划值**（`$directives`），由 **#33 的 `tool.dispatch` 节点**收集并并入其顶层 `$directives` 交宿主落账；**#27 自身只返回 `results`**，不落账、不冒泡。
- **并发在进程内、不在图里（写死）**：内核单 pending（eval 内不能并行）封死图级并行，但本插件对提供者的调用走**反向帧 `port.call`**（`docs/protocol.md` §2.4），同一服务可同时挂多个在途反向调用 ⇒ 整批 `calls[]` 在**本服务进程内并发扇出**，对宿主 run 不产生额外 directive（天然避开单 pending 与 O(k²)）。
- **上限与背压**：并发上限（缺省 4，住 schema）与每工具 `caps.timeout_ms` / `mem_mb` / `procs_max` 同管；超上限的 call **排队**而非丢弃。
- **部分审批（v1 口径，与 #33 对齐）**：批级升级判定归 #33 的 `tool.gate`——**v1 `any escalate` → 整批走 `approval.wait`**（整批不放行，见 #33）。「按 call 逐项拆批（部分放行、部分入队、批准后只补跑该项）」是 **post-v1**（#33 已登记为后续细化），本轮不改。
- **保序**：结果按 `call_id` 保序返回；同 `call_id` 重复 = 模型畸形（#33 的 `agent.step` `post` 已拦，见 #33）。
- **`tools` 与工具提供者类是两个层**（注册表 vs 提供者），不可混用；每个提供者类名唯一（§1.4）。
- **结果缓存**：宿主按 `(port, method, canonicalJson(args))` 缓存**幂等**结果，摊平内核「一个 directive 内 k 个效果 ⇒ O(k²) 续跑」（`kernel.md` §十二 门外逃生舱）；模型 `chat` 与写类工具永不缓存（`idempotent:false`）。
- **错误码**：本插件出 `unknown_tool` / `bad_tool_decl` / `bad_args` / `workspace_missing` / `needs_approval` / `denied`；提供者出 `tool_failed` / `tool_timeout` / `fs_denied` / `sandbox_unsupported` 等，**原样透传**（不吞、不改写）；**超时透传提供者原码（如 #25 `timeout`），不改写**（2026-09-20 修订）。
- **反向调用**：提供者 / 本插件对 `pins` 里其他身份的调用走**帧协议第二方向（服务 → 宿主 `port.call`，`docs/protocol.md` §2.4）**，按发出者身份 `pins` 路由；世界里的 `eff` 记 `EffectAudit`，反向调用只记**宿主侧端口审计**、不入世界。

### 工具卡渲染（各工具插件自带）

- `describe` 可选回 `render` 描述符，声明**这条工具调用怎么画**（不投递浏览器代码）：

  ```jsonc
  { "form": "line" | "card",        // line = 消息流里一行（不可展开）；card = 可折叠卡片
    "label": "edit",                // 折叠态前缀标签
    "summary": "{path}  +{result.added} -{result.removed}",   // 折叠态摘要模板（文法见下，冻结）
    "tone": "ghost" | "plain" | "solid",        // 卡片质感：ghost 近乎透明 / plain 常规 / solid 高危写类
    "detail": { "kind": "diff", "before": "…", "after": "…" },   // 展开态渲染器
    "live": false }                 // true = 动态输出（订阅 `tool.delta` 追加）
  ```

  - `detail.kind`（渲染器闭集）：`text` / `code` / `diff` / `matches` / `paths` / `list` / `table` / `json` / `file` / `image` / `terminal` / **`question`**（#48 交互卡：`interactive:true` + 问题 / 选项，提交经入站面写槽 + 按名调 `question.answer`，已答折叠）。**`diff` 载荷冻结为 `{kind:"diff", before, after}` 或 `{kind:"diff", patch}`**（两者取一、各工具保持一致）。
  - **`summary` 模板文法（冻结）**：裸 `{field}` = **args 字段**（如 `{path}`）；`{result.field}` = **结果字段**（如 `{result.added}`）；`{args.*}` / `{result.*}` 前缀写法不再使用。过长由 #18 截断（不换行溢出）。
  - `form:"line"` 时 `detail` 忽略（如 `read` 只画一行）。
- **归属 = 各工具插件自带**（#18 只留挂载点）：**render 描述符随 `results` 返回；由 #33 `tool.dispatch` 落消息 part 进 #11**（**本插件不写 #11**），#18 按 part 渲染 → 展示与回放确定、**不依赖当前工具集**（换工具插件不影响旧消息渲染）（2026-09-20 修订）。
- **动态输出（`live:true`）**：宿主透传的事件（不进世界、不参与哈希）——
  `tool.start {run, thread, call_id, tool, render, args}`（#27 派发时发，`run` / `thread` 自协议帧 `env` 读，H16）/ `tool.delta {run, thread, call_id, seq, chunk}`（提供者经宿主 `event` 发，如 #29 的 stdout 流）/ `tool.end {run, thread, call_id, ok}`（2026-09-20 修订）。
  #18 在 `tool.start` 即开卡、按 `call_id` 追加 `tool.delta`；run 结束以消息 part 的**定稿结果**替换实时态（**回放只读定稿**，事件不落账）。
- **降级**：无 `render` 或未知 `kind` → #18 按 markdown 文本降级渲染（不空白、不报错）。
- **升级路径（版本提升）**：需要真自定义组件时，再给工具插件加**浏览器侧渲染模块**投递面（headless 子应用向 #18 注册渲染器），描述符仍是其声明面。
- **登记**：#11 消息 part 新增 `render` 字段（写时快照）——版本提升（提出方登记见 `plugins/session/DESIGN.md`）。
