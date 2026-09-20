# #46 `ui-threads`（线程顶栏）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 46 / `ui-threads` |
| 职责 | **线程顶栏**（slot `topbar`）：按 #11 会话列表（含 `kind` / `parent` / 标题）渲染标签；**鼠标悬浮显示、离开隐藏**；点击切换当前线程（main 区显示哪条线程）；**有待办（#47）时出一个「待办 N」标签位**；**内容按当前父会话隔离** |
| 依赖 | 无 pins；`~` 14（读会话列表 / 标题）；`+` 47（投影读待办清单）、11（投影读线程字段 `kind`/`parent`）——**投影读在入口 term，经只读命令 `threads.state` 触发**（按 ui-design §15：UI 服务不读投影、入口 term 可读；成员 `terms`）；收宿主事件（`thread.*` / `workflow.step` / `group.message`，emitter = #11 服务）；跨 slot 视图态经 `api.uiState`（`active_thread`）；**侧栏 `session.select` 落账后 #11 发 `thread.updated`（含 `current` 变）→ 本插件重算 `threads.state` 并按 `current` 重置 `active_thread`**（单桥：`current` ↔ `active_thread`——threads-design §四口径，#11 侧已登记）（2026-09-20 修订）；`<-` 15（挂载 `topbar`） |
| 成员 | execute（前端 entry.js）, terms（只读命令 `threads.state` 入口 + 投影读） |
| 能力类·方法 | `implements: ["ui-threads"]`，`methods: {"ui-threads":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | `threads.state`（无参；入口 term 投影读 #11 线程字段 + #47 待办清单，返回标签数据） |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 见下「标签 / 位置与显隐 / 切换」 |
| 边界 | 不做：对话渲染（归 #18）/ 群聊与步骤卡（归 #18 按 kind 分派）/ 判定 / 写世界本体（写走入站面）/ 无 pins 不发 eff |
| 验收 | 1) 默认「对话」标签；2) 会话标题更新后标签跟随；3) 开子代理 / 群聊 / 工作流后标签出现、点击切到对应视图；4) hover 显示、离开隐藏、**不推挤布局**（overlay）、**意图延时 150ms/300ms 生效**；5) 崩溃不影响 main / sidebar；6) 换 #11 / #18 实现零改动；7) **`threads.state` 只读命令返回标签数据（线程字段 + 待办），投影读在入口 term**；8) **点击标签经 `api.uiState` 广播 `active_thread`，`#18` 跟随切视图** |
| 状态 | 新增（2026-09-19，线程设计；完整背景见 `docs/plans/threads-design.md`） |

## 标签

- **来源** = #11 会话列表：每个线程一个标签，顺序 = 线程树（`main` 在前，子线程按 `parent` 归组）。**会话列表 / 标题直读 #11 投影（`threads.state` 入口 term）；`chat.history` 不用于本插件（防误导装配）**（2026-09-20 修订）。
- **文案**：默认「对话」；会话标题更新（#11 `rename` / 自动标题）后变**会话标题**；子代理 = **子代理会话标题**；群聊 / 工作流各一标签。
- **状态角标**：运行中（呼吸点）/ 待审批（warning 点）/ 完成 / 失败——**同源 `thread.updated` 的 `status` / `pending` 字段**（#11 事件；**不另订宿主 `run.*`**——#16 侧用宿主事件，两者数据源注记区分）（2026-09-20 修订），**不读世界本体**。
- **待办标签位（#47 `todo`）**：当前（父）会话**有未完成项**时，追加一个**「待办 N」标签**；点开显示清单（逐项状态，只读）；全部 `completed` / 清空后标签消失。**标签位本身不占 slot**（与其他标签同列）。

## 按父会话隔离（写死）

- **顶栏内容只属于当前父会话**：标签集合 = 该父会话（`main`）及其子线程（`parent` 指向它）+ 它的待办标签；**切换父会话 ⇒ 换一组标签**。
- 判定：以当前 `main` 线程为根，取 `parent` 闭包内的线程；待办取该 `main` 会话的清单（#47）。
- ⇒ 多会话并行时，顶栏不会把别人的子代理 / 待办混进来。
- **`current` ↔ `active_thread` 单桥（2026-09-20 修订）**：侧栏 `session.select` 落账后 #11 发 `thread.updated`（事件清单加 `current` 变触发）→ 本插件重算 `threads.state` 并按 `current` 重置 `active_thread`（threads-design §四口径；#11 侧已登记）。

## 位置与显隐

- 位置：**侧边栏右侧、`main` 顶部**；常态 0 高度（不占位），**鼠标进入顶部热区才 overlay 展开**，离开隐藏。
- **热区 = `main` 列顶部 8px 高条带（写死，2026-09-20）**：横向不含 sidebar；实现为顶栏自身的隐形 hit-strip（`--z-topbar`）。
- **被更高层级覆盖时自然不可达、无需特判（登记行为）**：S6 断线横幅（z40 通栏悬浮）显示期间物理盖住热区 ⇒ **断线期间顶栏不展开——横幅优先**；设置模态遮罩（z60）同理。
- 不推挤布局（与 #15 的 S6 断线横幅同路：overlay，不改变 column 高度）。
- 展开 / 收起 150ms；当前激活标签有 `selection` 底。
- **hover 意图延时 150ms 出 / 300ms 收**（与 #16 收缩态 flyout 同一口径，防鼠标划过顶部误触）；层级用 `--z-topbar`（ui-design §16.11）。
- **已知例外（ui-design §11.10 / §14）**：本顶栏为**纯 hover 交互**，**键盘不可达、触屏不可用**（2026-09-19 用户定）——键盘 / 触屏用户无法经顶栏切换子代理 / 群聊 / 工作流线程。此为例外，新增 hover-only 交互前须先登记。

## 切换

- 点击标签 → **纯前端视图态变更**（`main` 区显示哪条线程不落世界）：本插件 `api.uiState.set('active_thread', threadId)`；`#18 ui-chat` 订阅该键，按 `chat.history {conversation}` 重拉对应线程消息并渲染。**跨 slot 视图态只走 `api.uiState`**（壳中介，见 `docs/plans/ui-design.md` §15），世界/状态派生数据（`thread.updated` / `group.message` / `workflow.step`，emitter = #11 服务）仍走宿主事件。**侧栏 `session.select` 落账后 #11 发 `thread.updated`（含 `current` 变）→ 本插件重算 `threads.state` 并按 `current` 重置 `active_thread`**（单桥：`current` ↔ `active_thread`——threads-design §四口径，#11 侧已登记）（2026-09-20 修订）。
- **不引入新的入站指令**：切换是纯前端视图态（与"哪条消息被选中"同级），刷新后回到默认 `main`；若需持久化"上次查看的线程"，走 `#2 config` 的 UI 偏好字段（后置），不落 #11。
- **UI 插件互不 pin**：跨 slot 世界/状态同步走宿主事件，跨 slot 视图态走 `api.uiState`（见 `docs/plans/ui-design.md` §15）。
- 工作流标签额外订阅 `workflow.step` 更新步骤卡进度；群聊标签订阅 `group.message` 更新未读角标。
- **未读角标口径（2026-09-20 写死）**：角标 = 本插件**内存计数**（视图态不落世界）——`group.message` 到达且 `thread ≠ active_thread` 时 +1；**切入该线程（`active_thread` 变为它）即清零**；**刷新即丢（登记限制，与 #18 的 `last_seen` 锚点同口径）**。角标是粗粒度知会、消息流内未读锚点（#18）是细粒度定位，二者不联动（分工见 `plugins/ui-chat/DESIGN.md`「未读锚点」）。

## slot / 端口（③）

- slot = `topbar`（`#15` 布局新增）；子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），绑定 127.0.0.1，具体值由 #15 挂载表定；本插件不自开对外端口。
- 共用契约见 `docs/plans/ui-design.md` §15「slot 应用契约」。

## 跨插件登记

- **#15 ui-shell**：布局新增 `topbar` slot（侧边栏右侧、main 顶部）；本插件挂载于此。
- **#11 session**：读会话列表与 `kind` / `parent` / 标题（版本提升：会话加这些字段，见 `docs/plans/threads-design.md`）。
- **#18 ui-chat**：本插件经 `api.uiState` 广播 `active_thread`；#18 订阅后按 `chat.history {conversation}` 重拉对应线程并渲染，具体渲染归 #18 按 `kind` 分派。
- **#15 ui-shell**：`api.uiState` 由壳提供（键空间登记见 `plugins/ui-shell/DESIGN.md`「跨 slot 视图状态」）；本插件不占 `uiState` 之外的通道。
- **#33 loop-policy**：工作流标签的进度来自其图执行状态（`workflow.step` 事件）。
- **#47 todo**：待办标签位——当前父会话有未完成项时出现，点开显示清单（只读）；标签位与清单都按父会话隔离。
- **#16 ui-sidebar / #17 ui-settings S13（三处分工，2026-09-19 补）**：**顶栏 = 当前父会话内的切换与运行态**（本插件）；**侧栏 = 跨会话全局运行态**（#16 角标，见其「会话项状态角标」）；**S13 Scope 名录 = 历史审计与健康**（#17）。三处不重复做同一件事——顶栏不做历史审计、S13 不做快速切换、侧栏不重复父会话内的线程标签。
