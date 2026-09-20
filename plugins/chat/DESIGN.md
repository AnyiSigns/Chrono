# #14 `chat`（命令面 + 回合编排 + 接线）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 14 / `chat` |
| 职责 | 命令面（`chat.send` / `chat.history`）+ 回合管道 term + 接线配置；**无 execute** |
| 依赖 | `+` 1（入口 term 读输入槽判分支）；`->` 11、12、13（pins）、**33（`loop-policy`，pins：入口 term effs `loop-policy.interpret`，#33 到位后替换本管道）**、**49（pins：`session-title`，首条消息标题段）**；`<-` 16、18（按名调用）；版本提升：33 替换其管道（命令面仍归 14）、34 到位后**新增** `router` pin + 备选别名 pin（**`model` 仍 pin 12**，见 34） |
| 成员 | terms, schema |
| 能力类·方法 | 无（不被别人调用） |
| 命令 | `chat.send`（跑管道；无参）、`chat.history`（读 11 投影；args 可选 `{ conversation?, before?, limit? }`，缺省 `conversation` = `current`、缺省窗口 = 最近一窗） |
| schema | `schema/wiring.json`（切片清单 + 管道段序 + 超时 / 空槽行为；可热改） |
| 机制 | 见下「管道 / 命令 / 接线 / 失败」 |
| 边界 | 不做：写世界（归 11）/ 分支策略 / 自建循环 / 工具与审批编排（归 33）/ 调模型实现（归 12）/ 组装实现（归 13）/ **term 不拼 JSON**（ctx 与 args 合流只发生在服务里） |
| 验收 | 1) 两条命令可用：`chat.send` 无参、`chat.history` 支持可选 `{conversation, before, limit}` 窗口；2) 换下游实现不改 14；3) 管道换代热生效；4) 空槽 / 非 chat 槽幂等（不产生业务写）；5) 读命令不触发 eff；6) `chat.history` 返回展示历史窗口、不经组装视图、可翻页取全量；7) **首条用户消息后触发 `session-title.generate`，非首条不触发，且标题段失败不影响主回合** |
| 状态 | 细节设计（2026-09-19）：管道段序 / 命令语义 / 接线 schema / 失败口径冻结；失败由 11 写 system 消息 |

## 管道（静态嵌套 eff）

```
chat.send（无参，读槽 kind）
  -> eff 13 context.build          （组装 messages + params；切片清单由本插件 wiring 冻结）
  -> eff 12 model.chat             （流式；逐段 event model.delta）
  -> eff 11 session.commit         （原子写：user + assistant 两条消息 def + 会话 body + 清槽）
  -> eff 49 session-title.generate （**仅首条用户消息**；旁路，on_fail=ignore，见下）
```

- 段序与切片清单住 `schema/wiring.json`（**热改 = 换代**，进程不动）；#33 到位后可**替换**本管道（命令面仍归 14）。
- **召回先于组装**：`#33` 管道在本段之前插 `#22 retrieval`（命中写 bag），故 `#13` 不是「回合第一个服务」；v1 静态管道无召回段（`slices.recall=false`，`#22` 未就位）。
- term 只做**管道与选择**（读槽 kind 分支、按段序发 eff）；不拼 JSON、不写世界。
- 各段入参由宿主按 directive 的 `ctx` / `args` 透传，**ctx 与 args 的合流只发生在服务里**（§1.2 第 2 条）。

## 命令

| 命令 | 语义 | 备注 |
| --- | --- | --- |
| `chat.send` | 无参；读 `#1` 槽 kind：`chat.message` → 跑管道；**空槽 / `idle` / 非 chat kind → 幂等 no-op + `extern{ok:true,noop:true}`** | 写类载荷已先入槽（§1.2 第 2 条） |
| `chat.history` | args 可选 `{ conversation?, before?, limit? }`（缺省 `conversation` = `current`、缺省窗口 = 最近一窗）；返回 `{ body, refs, next_before }` | **展示历史窗口**；客户端按 `conversation` 取会话、沿 `prev` 还原顺序、滚顶带 `before` 拉上一窗；**不经 #13 组装视图**（§1.2 第 12 条） |

- `chat.history` **不触发 eff**、不写链、不推进 head。
- `chat.send` 的槽清理由 **#11 `commit` 的计划**完成（失败也清，见 #11）。

## 接线 `schema/wiring.json`

```jsonc
{ "pipeline": ["context.build", "model.chat", "session.commit"],
  "slices": { "prompt": true, "l2": true, "l1": true, "skill": true, "recall": false, "history": true, "style": true },
  "system_prompt": "…（v1 缺省系统提示词本体）…",   // #33 未就位时由本管道提供；#33 到位后由 #33 `prompts.system` 经 context.assemble 写 bag 覆盖
  "tools": [],                                       // v1 工具 schema 来源 = 本管道的 wiring.tools（缺省空数组）；#33 到位后由 bag 传
  "title": { "segment": "session-title.generate", "when": "first_message", "on_fail": "ignore" },  // 首条用户消息后自动标题（#49）
  "on_empty_slot": "noop",                 // noop | error
  "stream": { "topic": "model.delta" } }
```

- `slices` = 冻结 `#13` 的切片清单（13 据此选材）；改此表 = 换代热生效。
- **`bag.system_prompt` / `bag.tools` 的 v1 来源**：#33 未就位时由**本管道的 `system_prompt` / `tools` 字段**（住 `wiring.json`，换代热生效）随 eff `context.build` 的 bag 传入；#33 到位后由 #33 `context.assemble` 节点写 bag 覆盖（#13 不读 #33 schema，见 #13「系统提示 / 工具 schema 都来自 bag」）。**解决 #33 就位前 prompt 来源空悬**。
- `on_empty_slot` 默认 `noop`（空槽幂等，验收 4）。
- **标题段（`title`，2026-09-19 补）**：**旁路段，不在 `pipeline` 数组内**（由 `title` 键单独声明；#33 替换 `pipeline` 时仍保留）。管道尾追加 `session-title.generate`，**仅当本回合是会话首条用户消息**（`#11` 投影：`title` 仍为缺省「新对话」且 `count == 0`）时触发；args = `{ conversation, first_message }`（`first_message` 从 `#1` 槽读出）。`on_fail = "ignore"`：标题生成失败**不使主回合 `refused`**。生成与兜底见 `plugins/session-title/DESIGN.md`。

## 失败

- 管道任一段结构化失败 → **由 #11 `commit` 追加独立 `system` 消息**（`meta.error`），回合以 `refused` 收口；#13 默认排除 system 错误消息（可选开关）。
- 取消（`cancel{run}`）→ 丢弃未落账部分；已落账不回溯。

## 跨插件登记

- **#33 `loop-policy`**：到位后可**替换本管道**（图解释器）；命令面仍归 14（版本提升已登记）。
- **#34 `router`**：**新增** `router` pin（+ 备选别名 pin），`model` 仍 pin `12`——`select` 只回选中的别名端口名，由本插件 term 以该值发 `eff`（原「pin 12 改指 34」口径作废，见 `plugins/router/DESIGN.md`）；`chat.history` 仍读 `#11`。
- **#49 session-title（版本提升：被提升方，2026-09-19）**：管道新增 `title` 段与 pin `session-title`；仅首条用户消息触发、`on_fail=ignore`；命令面与其它段不变。
