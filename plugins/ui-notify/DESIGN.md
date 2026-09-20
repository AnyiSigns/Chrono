# #38 `ui-notify`（系统通知 · headless 前端）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 38 / `ui-notify` |
| 职责 | 系统通知：把宿主事件转成本机通知（**headless 前端**，不占 slot） |
| 依赖 | 收宿主事件（无 pins）；读 `#2 config.ui.notify`（开关）——**开关读取经入口 term，由只读命令 `notify.state` 触发**（ui-design §15：UI 服务不读投影、入口 term 可读） |
| 成员 | execute, terms（只读命令 `notify.state` 入口 + 投影读 `ui.notify` 开关） |
| 能力类·方法 | `implements: ["ui-notify"]`，`methods: {"ui-notify":["ping"]}`（占位；headless 前端，不被 pin） |
| 命令 | `notify.state`（无参；入口 term 投影读 `#2 config.ui.notify`，返回各开关当前值 + 浏览器权限状态供 #17 S7 显示） |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 见下「订阅 / 默认规则 / 通知形态 / 开关」 |
| 边界 | 不做：会话视图 / slot 视图 / 判定 / 写世界；服务不读投影（开关经入口 term 读，见依赖行）、无 pins 不发 eff。**口径**：通知只是提示、**不挂操作按钮**；裁决必须回 `#39` 卡片做（不在通知里做安全操作） |
| 验收 | 1) 七类事件按规则触发；2) 关闭后不影响其它前端；3) 通知失败不影响对话；4) 开关可配且热生效；5) 前台不重复打扰（`tool_call` 待审批 / 回合完成不弹）；6) **不占 slot**（`headless` 加载）；7) **结构变更（编排 / 插件写）前台也通知**，且通知不挂裁决按钮；8) 编排连续失败通知来源是 #44 服务（**周期（宿主定时触发）`aggregate`** 自动发，不依赖用户打开 S13）；9) **浏览器权限状态可在 S7 读出，未授权时开关置灰并给出请求 / 指引**；10) **`notify.state` 只读命令返回开关值与权限状态，投影读在入口 term**；11) **`question.pending`（agent 提问待作答）始终通知**；12) **同一 `(thread,kind)` 5s 内合并为一条、同屏最多 3 条，结构性事件不节流** |
| 状态 | 细节设计（2026-09-19）：**订阅事件集 + 默认规则 + 开关归属**冻结；定位 = 浏览器侧 headless（由 `#15` 以 `headless` 条目加载）。**版本提升（被提升方）**：新增 `orchestration.unhealthy` 事件与 `approval.pending` 按 `kind` 分流（`approval.pending` 事件由 #32 发、`orchestration.unhealthy` 由 #44 发，本插件是消费方；事件提出方登记见 `plugins/approval/DESIGN.md` 与 `plugins/evolve-metrics/DESIGN.md`） |

## 运行位置（写死）

- 本插件是**前端插件**（`execute` 供 `entry.js`），但**不占 slot**：`#15` 的**独立 headless 清单**负责加载它（**不进 `state/ui-mounts.json`**；见 `plugins/ui-shell/DESIGN.md`）。
- 它经 `#15` 的 `/events` SSE 收宿主事件，按规则调浏览器 `Notification` API；**宿主侧服务无法调浏览器 API**，故不存在「服务直接发系统通知」的路径。
- 不占端口、不进 slot 布局、失败隔离同其它子应用。

## 订阅（七类事件）

| 事件 | 来源 | 默认规则 |
| --- | --- | --- |
| `approval.pending` | #32 | **仅窗口无焦点时**通知（前台由 #39 卡片呈现）；**结构变更例外，见下** |
| 回合完成（`run.finished`） | 宿主（宿主事件面） | **仅窗口无焦点时**通知 |
| 回合失败（`refused` / 错误收口） | 宿主（宿主事件面） | **始终**通知 |
| 模型错误（`model_timeout` / `model_rate_limited` / `model_auth_failed` …） | #12 | **始终**通知 |
| 断线（S6，与宿主断开） | #15 / 宿主 | **始终**通知 |
| **编排连续失败**（`orchestration.unhealthy`） | **#44 `evolve-metrics`**（**周期 `aggregate`** 自动发） | **始终**通知（本轮新增，见下） |
| **提问待作答**（`question.pending`） | **#48 `question`**（提问入队落账后发） | **始终**通知（2026-09-19 补：agent 提问后本 run 正常结束，人在后台时会静默挂起，必须通知） |

- 经 `#15` 的 `/events` SSE（浏览器侧）收宿主事件 → 按规则调浏览器 `Notification` API；不占端口、由 `#15` 以 `headless` 条目加载（不占 slot）。
- **失败始终通知**（验收优先项）；「待审批 / 完成」在窗口前台时不弹（避免与 #39 / #18 双重打扰）。

## 结构变更与编排健康（本轮新增）

**`approval.pending` 按 `kind` 分流**（`#32` 的 item 带 `kind`，事件载荷透传）：

| `kind` | 规则 | 标题 |
| --- | --- | --- |
| `tool_call` | 仅无焦点时（原有） | 待审批 |
| **`orchestration_change`** | **始终通知**（即使前台） | 待审批：编排变更 |
| **`plugin_write`** | **始终通知**（即使前台） | 待审批：插件写入 |

- **为什么结构变更前台也通知**：工具调用是回合内的一步，人正看着对话时 #39 卡片够用；
  而**编排变更 / 插件写改的是系统自身行为**，影响后续所有回合，漏看一次的代价远高于多弹一次。
  通知只提示、**不挂裁决按钮**（既定口径），仍须回 #39 卡片看全文与影子指标再裁决。

**`orchestration.unhealthy`（编排连续失败）**：

- emitter = **#44 `evolve-metrics` 服务**（**宿主定时触发的周期 `aggregate`** 自动发，不依赖用户打开 S13）——#44 读 #43 `trace` 投影，按**连续 N 次 `refused` 收口**计数（与 #17 S13 同源口径）超 #33 `thresholds` 即发。**emitter 是 #44**（#44 是纯统计、不跑 #33 解释器，故 #33 图坏掉时仍能发；#17 S13 降为只读视图）。
- 图坏了 #33 自身可能走不通，但 #44 是纯统计、读 trace 投影，不跑 #33 解释器，故即便 #33 坏了仍能发该事件。
- 通知正文 = "编排连续失败 N 次，可在设置 → 编排回滚到上一世代"；点击聚焦 shell（不直接执行回滚）。
- **不挂"立即回滚"按钮**：回滚是结构性操作，必须在 #17 S13 看到健康详情后再做。

## 通知形态

- **OS 原生模板**：不自绘、不挂按钮——标题 = 事件类型（回合完成 / 回合失败 / 待审批 / 待审批：编排变更 / 待审批：插件写入 / 模型错误 / 断线 / 编排连续失败 / 提问待作答），正文 = 会话名 + 首行摘要（≤80 字截断）。
- 点击通知 = 聚焦浏览器页（shell）；裁决必须回 `#39` 看全文再做。
- **去重与节流（2026-09-19 补，防轰炸）**：同一 `(thread, kind)` 在 **5s 窗口**内重复到达只弹一条（后续计数合并，如「待审批 ×3」）；**同屏最多 3 条**系统通知，超出按到达顺序排队；`question.pending` / `orchestration.unhealthy` 不受节流（结构性，必须即时）。
- 勿扰 / 免打扰交系统策略接管。

## 开关（全局，`#2 config.ui.notify`）

```jsonc
"ui": { "notify": {
  "approval_pending": true, "run_finished": true, "run_failed": true,
  "model_error": true, "disconnected": true,
  "orchestration_change": true,          // 编排变更待审批（默认前台也通知）
  "plugin_write": true,                  // 插件写入待审批（默认前台也通知）
  "orchestration_unhealthy": true,       // 编排连续失败
  "question_pending": true,              // 提问待作答（始终通知）
  "only_when_unfocused": true } }        // 仅作用于 tool_call 待审批 / 回合完成
```

- 开关住 `#2 config.ui.notify`（**全局、可热改**）；浏览器 `Notification` 权限独立（未授权则不弹、不报错）。
- 配置写入入口：`#17 ui-settings` S7 通用页（新增「通知」分组）。

## 浏览器通知权限（2026-09-19 补）

- **权限状态可读**：本插件（headless）经浏览器 `Notification.permission` 读 `default` / `granted` / `denied`，把状态暴露给 #17 S7 通知分组显示——**开关开了却收不到通知时，用户能看到原因**，而不是以为坏了。
- **请求入口在 #17**：请求授权必须由**用户手势**触发（浏览器要求），故 [请求授权] 按钮住 `#17 ui-settings` S7 通知分组（slot 应用，能拿到点击手势）；点击调 `Notification.requestPermission()`，结果回写显示。
- **未授权（`default`）时**：开关置灰（`opacity:.45` + tooltip「浏览器未授权」）+ 分组内 12px 说明；**不报错、不弹 toast**。**已拒绝（`denied`）时**给指引「请在浏览器站点设置中允许通知」（文案走 `messages.v1.json`），**不重复弹系统请求**（浏览器也不再弹）。
- **与开关的关系**：`ui.notify` 开关是「产品层是否要通知」，浏览器权限是「系统层是否允许」；**两者都满足才弹**。任一不满足都不影响其它前端（既有边界）。
- 权限状态变化无事件源，故 **S7 每次打开时重新读一次**。

## 跨插件登记

- **#2 config**：新增 `ui.notify`（**版本提升：提出方** —— 本插件要求 config 升一代；被提升方登记见 `plugins/config/DESIGN.md`）。**本轮追加**三个开关键（`orchestration_change` / `plugin_write` / `orchestration_unhealthy`）。
- **#17 ui-settings**：S7 通用页新增「通知」分组（写 `ui.notify`）；S13 `orchestration.health` 降为只读视图（不再发 `orchestration.unhealthy`，emitter 移交 #44）。
- **#15 ui-shell**：通知点击聚焦 shell；S6 断线事件来源；**本插件以 `#15` 独立 headless 清单加载（不进挂载表、不占 slot）**。
- **#39 ui-approval**：前台 `tool_call` 待审批由卡片呈现，通知不重复、不挂操作；**结构变更两类前台也通知**（卡片仍是唯一裁决处）。
- **#32 approval**：`approval.pending` 事件载荷带 `kind`，本插件据此分流规则与文案。
- **#48 question（2026-09-19 补）**：`question.pending` 事件（提问入队落账后由 #48 服务发，载荷带 `run` / `thread` / 队列项 id）；本插件**始终**通知，点击聚焦 shell 到该会话，作答仍回 `#18` 消息流内的 question 卡（通知不挂作答按钮）。
- **#33 loop-policy**：连续失败阈值住其 `thresholds`（本插件不读，由 #17 的 term 读投影判）。
