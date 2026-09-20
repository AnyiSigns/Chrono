# #49 `session-title`（会话自动标题）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 49 / `session-title` |
| 职责 | 按会话**首条用户消息**，用**用户配置的模型**生成 **≤10 字**标题，写入 `#11` 会话 `title` |
| 依赖 | `->` 12（pins：`model.complete`，非流式单次补全）、`->` 11（pins：`set_title`）；`+` 2（vendor / model / params **由 #14 入口 term 读出随 title 段 args 传入（§1.14）**，服务不读投影）；`<-` 14（pins：管道段 `session-title.generate`，仅首条用户消息触发）（2026-09-20 修订） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["session-title"]`，`methods: {"session-title":["generate"]}` |
| 命令 | 无（由 #14 管道 eff 调 `generate`，不暴露命令面） |
| schema | `schema/title.json`（提示词 / 字数上限 / max_tokens / 兜底策略 / 超时；可热改） |
| 机制 | 见下「触发 / 生成 / 后处理与兜底 / 写入」 |
| 边界 | 不做：标题显示（归 16 / 46）/ 重命名 UI（归 16）/ 模型实现与韧性（归 12）/ 判定是否首条（归 14）/ 写世界本体（返回 #11 计划）；**不覆盖用户手动标题**；不内置任何模型名 |
| 验收 | 1) 首条用户消息后标题生成且 ≤10 字；2) 用**用户配置的模型**（非内置）；3) 模型失败 / 超时 / 空 → 用首条消息前 10 字兜底、**主回合不受影响**；4) 用户手动重命名后不再自动覆盖；5) 非首条消息不触发；6) 换 12 / 11 实现零改动；7) 标题写入可回放 |
| 状态 | 新增（2026-09-19，用户定：**用户配置的模型 + 首条用户消息 + ≤10 字**） |

## 包契约 `plugin.json`

```jsonc
{ "identity": "session-title",
  "implements": ["session-title"],
  "methods": { "session-title": ["generate"] },
  "pins": { "model": "model-protocol", "session": "session" },
  "schema": "schema/title.json",
  "start": "node execute/main.js",
  "protocol": "1",
  "restart": {}, "health": {},
  "state": "recomputable",
  "members": [{ "kind": "execute", "path": "execute/" }, { "kind": "schema", "path": "schema/" }],
  "commands": [] }
```

## 触发

- 由 **`#14` 入口 term** 判定（`#11` 投影 `title` 缺省且 `count == 0`，轮首 round-anchored）后**在首条用户消息的回合追加 title 段** `session-title.generate`（2026-09-20 修订）：
  - `when = first_message`：`#14` 入口 term 读 `#11` 投影，会话 `title` 仍为缺省「新对话」且 `count == 0`（即本回合是首条用户消息）时触发；否则**跳过**。
  - args = `{ conversation, first_message, vendor, model, params, title_default }`（#14 入口 term 读 `#1` / `#2` / `#11` 装配，§1.14；`first_message` = 本回合用户消息文本）。
- **旁路失败（写死）**：`on_fail = "ignore"`——标题生成失败**不使主回合 `refused`**（标题是旁路增强，不是回合的一部分）；**机制**：#14 入口 term 对该段 eff 返回**不检查**（`EffResult{ok:false}` 或 error 值均跳过该段、主回合不受影响）。（2026-09-20 修订）

## 生成

- `vendor` / 所选 `model` / `params` **由 #14 入口 term 读出随 title 段 args 传入**（§1.14；服务不读投影）——**用户配置的模型**，本插件不内置任何模型名、不自建默认表。（2026-09-20 修订）
- `eff 12 model.complete { messages, max_tokens }`：**非流式**单次补全（不发 `model.delta`）。
  - prompt 住 `schema/title.json`，要求「只输出标题本身，≤10 字，不加引号 / 标点 / 解释 / 换行」。
- **为什么非流式**：标题不是对话内容；`model.chat` 的流式分片会被 `#18` 当成助手消息追加，污染消息流。故 `#12` 新增独立 `model.complete`（见「跨插件登记」）。

## 后处理与兜底

- **后处理**：去首尾空白 / 引号 / 换行 / 结尾标点；按**码点硬截断 ≤10 字**（CJK 每字 = 1，不按字节）。
- **兜底（确定性）**：模型失败 / 超时 / 返回空 → 取首条用户消息去空白后前 **10 字**截断作为标题；仍空 → 保留缺省「新对话」。**不报错、不弹卡片、不阻塞**（旁路增强，诚实但不打扰）。
- **不覆盖用户手动标题**：判定归 **#14**（`when` 轮首 round-anchored）；**#11 `set_title` 无条件写入**；回合内手动重命名竞态窗口极窄、**接受并登记**。（2026-09-20 修订：删「本插件写入前再校验一次」）

## 写入

- `eff 11 set_title { conversation, title }` → `#11` 返回写计划（`put` 会话 body 的 `title` + `add_gen`）；**可回放**；**写计划由 #14 入口 term 机械合并进顶层 `$directives`**（2026-09-20 修订）。
- `#11` **在返回计划的同时乐观发** `thread.updated`（标题变）→ `#16` / `#46` 自动跟随，**无需新事件**；**UI 以 `chat.history` 定稿**（2026-09-20 修订）。

## 跨插件登记

- **#12 model-protocol（版本提升：被提升方）**：新增方法 **`model.complete`**（非流式单次补全；同 `chat` 的密钥 / 韧性路径，**不发 `model.delta`**）。
- **#2 config（跨插件登记）**：`vendor` / `model` / `params` **由 #14 入口 term 读出随 title 段 args 传入**（§1.14；服务不读投影）；#2 的 `<-` 登记加 49。（2026-09-20 修订）
- **#11 session（版本提升：被提升方）**：新增方法 **`set_title {conversation, title}`**（服务调用路径，区别于读槽的 `rename`）；**`set_title` 无条件写入（首条判定归 #14）**（2026-09-20 修订）。
- **#14 chat（版本提升：被提升方）**：管道新增 `session-title.generate` 段（`when = first_message`、`on_fail = ignore`）；新增 pin **`session-title`**；**title 段 args 扩展为 `{conversation, first_message, vendor, model, params, title_default}`（#14 入口 term 装配，§1.14）；旁路段在 #33 接管后保留归 #14**（2026-09-20 修订）。
- **#16 ui-sidebar / #46 ui-threads**：标题显示沿用（`thread.updated` / `chat.history`），**不新增 UI**；本插件不生成标题以外的内容。
- **#17 ui-settings S8**：模型配置即标题生成所用模型，**无新配置项**。

- 框架层插件契约见 `docs/plugins.md`；本插件无 UI、无 slot、无命令面。
