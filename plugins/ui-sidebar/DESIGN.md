# #16 `ui-sidebar`（侧边栏）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 16 / `ui-sidebar` |
| 职责 | 工作区分组 + 会话列表 + 按工作区新建 + 重命名（就地编辑）+ 添加工作目录入口 + **会话项状态角标** + **会话管理（删除 / 标题搜索 / 导出 / 分支）** |
| 依赖 | `->` 11（pins：`session.new` / **`session.select`** / `session.rename` / **`session.delete`** / **`session.restore`** / **`session.branch`** 的入口 term 发 eff）；`->` 41 `workspace`（pins：`workspace.list` / `pick` / `add` / `remove` / `reveal` 的入口 term 发 eff；**已定 #41**，见 `plugins/workspace/DESIGN.md`）；`+` 1（入口 term 读槽判分支）；`~` 14（`chat.history`，含会话 `status` / `pending` / `inbox`）；**收宿主事件 `run.started` / `run.finished` / `thread.updated` / `approval.pending` / `group.message`（状态角标 / 未读与终止）**（2026-09-20 修订）；**会话列表 / 分组 / 角标数据统一经 `chat.history` 返回的 #11 body（唯一会话读面）；本插件不另设读面**（2026-09-20 修订）；`<-` 15（挂载） |
| 成员 | execute, terms |
| 能力类·方法 | `implements: ["ui-sidebar"]`，`methods: {"ui-sidebar":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | `session.new`（读槽取 `workspace_id`；入口 term eff `session.new_conversation`——命令名与方法名映射，#11 侧登记）（2026-09-20 修订）、**`session.select`**（读槽 `{kind:'session.select', conversation}`；切 `current`）、`session.rename`、**`session.delete`**（读槽 `{kind:'session.delete', conversation}`；软删）、**`session.restore`**（读槽 `{kind:'session.restore', conversation}`；撤销软删）、**`session.branch`**（读槽 `{kind:'session.branch', conversation, message}`；从某消息分叉）、`workspace.list`（无参；入口 term eff 到 41）、`workspace.pick`（无参；eff 到 41）、`workspace.add` / `workspace.remove`（读槽后 eff 到 41，写类走槽）、`workspace.reveal`（args `{workspace}`；eff 到 41，纯动作不走槽） |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 点击 -> 写槽 + 调自己的命令；分组列表 = `workspace.list` 返回值 + `chat.history` 按 `workspace_id` 归组；**点击已有会话 = 写槽 `{kind:"session.select", conversation}` + 调 `session.select`（切 `current`，跨 slot 由 #18 重拉 `chat.history` 跟随）**；新建 = 写槽 `{kind:"session.new", workspace_id}` + 调命令（入口 term eff #11 `session.new_conversation`——命令名与方法名映射，#11 侧登记）（2026-09-20 修订）；添加工作目录 = `workspace.pick` 取路径 -> 写槽 `{kind:"workspace.add", workspace, name, path}` + 调 `workspace.add`（`workspace` id 由前端生成）；[⋯] 移除 = 写槽 `{kind:"workspace.remove", workspace}` + 调 `workspace.remove`；[在文件管理器中打开] = 调 `workspace.reveal {workspace}`。**槽写入一律 per-thread 键控**（H11）：写 `#1` 时读-改-写 `body.slots`、只覆盖本线程键（`slots[<thread_id>]`，缺省 `_main`），不整值覆盖——见 #1「写入契约」 |
| 边界 | 不做：渲染消息 / 判定 / **消息级删除（只做会话级软删入口）** / 跨会话全文搜索（v1 只做标题本地过滤）/ 工作区本体与路径校验（归 41）/ 会话跨区移动（后置）；**服务不读投影**（入口 term 读 `input` 槽判分支）、不写世界（写走入站面） |
| 验收 | 1) 分组折叠与高亮正确；2) 各分组的 [新对话] 建到对应工作区且可回放；3) 添加工作目录走原生选择器、取消 / 失败均有明确收口；4) 就地编辑键盘行为正确；5) 换 11 / 41 实现零改动；6) 移除工作区只移出列表（不动磁盘、不删会话）；7) 目录缺失态（`missing`）正确渲染且不阻塞已有会话；8) **状态角标（运行 / 待审批 / 失败 / 未读）随宿主事件正确更新、无常驻红点**；9) **可终止非当前线程 run（`api.cancel`）**；10) **会话删除软删 + 撤销 toast 可恢复（`session.restore`）**；11) **标题搜索本地过滤正确**；12) **导出生成 markdown / JSON**；13) **768–1023 / <768 强制收缩且不引入抽屉**；14) **点击历史会话写 `session.select` 并切 `current`，主区跟随** |
| 状态 | 已定（2026-09-18 改版：会话按工作区划分、新对话内嵌各分组，取消独立工作区选择器行）；**版本提升：提出方** —— 要求 #2 `config` 升一代新增 `ui.sidebar_width`（登记见 `plugins/config/DESIGN.md`） |

```
Chrono
[ + 添加工作目录 ]                       ← folder-plus 图标 + 文字
▾ 工作区 A                    [新对话] [⋯]   ← chevron-down + folder 图标
     会话 A1
     会话 A2
▸ 工作区 B                                   ← chevron-right + folder 图标
[ 设置 ]  [展开|收缩]
```

> 上图为结构示意，**不写 emoji**；实际图标一律 §8 的 linear 单色（分组头 folder / 顶部 folder-plus / [新对话] pencil / [⋯] more-horizontal / 折叠 chevron-down|right）。

- 展开 260 / 收缩 56；分组头高 30、会话项高 34、圆角 6、当前会话项 `selection` 底；五态与图标规范见 `docs/plans/ui-design.md` §8–§9。

**交互细则（2026-09-19 补，全局规范见 ui-design §16）**

- **tooltip**：分组名（全路径）、目录缺失原因、[新对话] / [⋯] / [终止] 图标按钮名称、窄屏收缩态按钮名称，一律走 §16.1 规范（hover 400ms 意图延时、`aria-describedby`、不承载关键信息）；tooltip 由本插件自绘。
- **单击 / 双击**：会话项**单击 = 立即切换**（不引入单击延迟）；**双击 = 就地重命名**（第二击 250ms 内）；双击非当前项先切换再重命名，不去抖（§16.4）。
- **命中区**：所有图标按钮（重命名 / [⋯] / [终止] / 折叠 / 底部）命中区 ≥24×24（§16.3）；拖拽命中区 4px 例外。
- **触屏**：收缩态 flyout、hover 淡入按钮、tooltip 均为 hover-only；触屏暂不支持（ui-design §14），登记为已知限制。

**视觉细节（2026-09-18 逐插件定案）**

- **产品名区**：纯文字 wordmark「Chrono」18px 600 `--c-text`，无 logo 图形（后期可升级为 20px linear 图标+文字，不动布局）；收缩态显示首字母「C」同字规居中。
- **[+ 添加工作目录]**（原 [+ 新对话] 位置，2026-09-18 改）：ghost 整行——34px 高、`--radius-md`、无底无边框，folder-plus 16px + 「添加工作目录」14px；点击 → 调 `workspace.pick`（**系统原生目录选择器**，由 41 插件在宿主侧拉起）。
  - 等待期间行内按钮内等待态：「等待选择…」+ 16px 呼吸环（§10）；取消 → 100ms 恢复；
  - 成功 → 新分组 150ms 淡入并自动展开，会话列表空；
  - 失败 / 无图形会话 → 行内 danger 文字「系统选择器不可用」+ 指引用 CLI / 启动参数指定目录；**不提供路径输入框**（2026-09-18 定）。
- **分组头（工作区）**：行高 30；`[chevron-down | chevron-right 16px，24×24 独立命中区]` + folder 16px + 名称 13px `--c-text` ellipsis（hover tooltip 显全路径）；右端 [新对话] pencil 16px 图标按钮（24×24、**常显**、tooltip「在此工作区新建对话」）+ hover 淡入 [⋯ more-horizontal 16px] 图标按钮；**整行点击（按钮之外）= 折叠 / 展开**；hover 底色升一级。
- **[⋯] 菜单**（锚定弹层，§9）：[在文件管理器中打开]（folder-open）/ [移除工作区]（danger 前景字）；移除仅移出列表，**不动磁盘、不删会话**（该组会话随之隐藏，数据保留）。
- **无「当前工作区」态**：每个分组各自带 [新对话]，故不需要选区高亮、也不需要独立选择器行；点哪个分组的 [新对话] 就建在哪个工作区。
- **会话列表项**：单行标题 14px ellipsis（无时间 / 摘要第二行），项高 34、左缩进 20px 表达层级；右端 hover 淡入重命名图标按钮（pencil-line 16px，24×24 点击区）；**整行点击 = 切到该会话**（写槽 `{kind:'session.select', conversation}` + 调 `session.select`）；当前项 `--c-selection` 底、比 hover 底深一档，无 accent 竖条、不加粗。
- **目录缺失态**：分组头 danger 点 6px + 名称 `--c-text-3` + tooltip「目录不存在」；[新对话] 置灰禁用（tooltip 说明原因）；已有会话仍可读（只读浏览不阻塞）。
- **空分组**：展开后无会话时不渲染任何占位行（保持紧凑，[新对话] 就在组头）；**这是 §10 空态规范的分组内例外**——仅当整体无任何工作区 / 会话时，才在列表区出空态三行（图标 + 「还没有会话」+ [添加工作目录]）。
- **首启默认**：自动把宿主进程 cwd 加入为第一个工作区（零摩擦、可直接开聊）；列表为空时仅顶部 [+ 添加工作目录] 可用。
- **底部行**：[设置]（settings 图标+文字 ghost 行）+ [展开|收缩]（panel-left / panel-left-close 图标按钮 34×34）；收缩态为竖排 40×40 图标按钮：folder-plus（添加工作目录）/ 设置 / 展开。**[设置] 点击 → `api.uiState.set('settings_open', true)`（`settings_open` 的写者，#15 侧登记）**（2026-09-20 修订）。
- **宽度可拉伸（2026-09-18 增）**：展开态右缘 4px 拖拽命中区（`cursor: col-resize`），范围 220–420px（默认 260）；拖拽 hover 时分隔线加深为 `--c-text-3`；拖动即时生效、无动画、无吸附；松手后防抖 300ms 写回 `2`（config）持久化、可回放；收缩态不可拉，需先展开。
- **收缩态 hover 浮出列表（flyout）**：hover 会话区 150ms 意图延时后，从侧栏右侧滑出 260px 宽浮层（`--c-surface` 底、`--shadow-pop`、`--radius-md`、100ms 淡入+2px 位移），内容为**完整分组列表**（分组头 + [新对话] + 会话项，规格同展开态）；点击会话即切换并收起；指针离开 300ms 后收起。flyout 为 §9 弹层白名单中「锚定下拉」之外的唯一悬浮列表例外。

## 会话项状态角标与全局运行态（2026-09-19 补）

- **角标（会话项右端，不占额外行高）**——解决真并发下「哪条在跑 / 卡审批 / 失败」不可见：

  | 状态 | 角标 | 来源（事件名 → 订阅） |
  | --- | --- | --- |
  | 运行中 | 6px 呼吸点（accent，§10 呼吸族） | `run.started` / `run.finished`（宿主事件面，`impl="host"`；订阅后按 `thread` 映射到会话项）（2026-09-20 修订） |
  | 待审批 | 6px warning 点 | 订阅 `approval.pending`（#32，载荷带 `thread`）/ 会话 `pending.approval` |
  | 失败 | 6px danger 点 + tooltip 人话 | 会话 `status:"failed"` / 订阅 `thread.updated`（#11） |
  | 未读（群聊 / 子代理） | 12px 计数 `--c-text-2` | 会话 `inbox` / 订阅 `group.message`（#11；未读来源）（2026-09-20 修订） |

- **不常驻红点**：失败 / 待审批点随状态消失（§1 原则 4 禁常驻红点）；tooltip 文案走 `messages.v1.json`；角标变化 100ms 淡入淡出；未读计数用 `tabular-nums`（§16.10）。
- **终止非当前线程**：运行中的会话项 hover 淡入 [终止] 图标按钮（square 16px）→ **就地二次确认**（3s，同 #39 口径）→ 经 `api.cancel(run)` 发协议 `cancel{run}`；`run` 由 `run.started` 事件按 `thread` 映射得到。**`thread:null` 的 run 不显示角标；写死 #40 提交时带 `thread=active_thread`**（#40 侧已登记）（2026-09-20 修订）。**这是「切走线程后仍能收回后台回合」的入口**（#40 的终止只管当前线程）。
- 数据面：会话 `status` / `pending` / `inbox` 随 `chat.history` body 返回（#11），实时性靠宿主事件。**会话列表 / 分组 / 角标数据统一经 `chat.history` 返回的 #11 body（唯一会话读面）；本插件不另设读面**（2026-09-20 修订）。

## 会话管理（2026-09-19 补，原「删除 / 搜索 / 导出后置」定形态）

- **会话项 [⋯] 菜单**（more-horizontal，hover 淡入；与工作区分组头 [⋯] 同语言）：[重命名]（pencil-line）/ [导出]（download）/ [分支]（git-branch，后置）/ [删除]（trash-2，danger 前景字）。
- **双击会话项 = 就地重命名**（与 hover 的 pencil-line 图标同路径）；键盘 F2 同效；Enter 提交、Esc 取消、失焦提交。
- **删除（v1，软删 + 可撤销）**：`[⋯] → 删除` → **就地二次确认**（整行变「确认删除？[删除] [取消]」保持 3s，不弹窗）→ 写槽 `{kind:'session.delete', conversation}` + 调 `session.delete`。删除后会话移出列表、**消息 def 保留不回溯**（#11 红线）；弹**撤销 toast「已删除 · 撤销」**（toast 归 #15，`action` 触发 `session.restore`）。
- **标题搜索（v1）**：侧栏顶部（[+ 添加工作目录] 上方）34px 搜索行，search 16px + placeholder「搜索会话」；输入即时**本地过滤**会话标题（`chat.history` body 已含全部标题，无需后端）；匹配高亮、Esc 清空、无结果显示「无匹配」。**跨会话全文搜索后置**。
- **导出（v1，客户端）**：`[⋯] → 导出` → 用 `chat.history` 窗口在客户端生成 markdown / JSON，走浏览器下载；不写世界、不需后端。**导出中** = [导出] 菜单项走按钮内等待态（§10，大历史时 >8s 文案「导出中…」）；成功 toast「已导出」、失败 danger toast（人话，走 `messages.v1.json`）。
- **分支（后置，形态已定）**：从某条消息 `[⋯] → 分支` → 写槽 `{kind:'session.branch', conversation, message}` + 调 `session.branch`（新会话 + 以该消息为父链拷贝）；需 **#11 版本提升**（见「跨插件登记」）。
- **自动标题**：由 **#49 `session-title`** 生成（**首条用户消息 + 用户配置的模型 + ≤10 字**，非流式），本插件只显示（随 `thread.updated` / `chat.history` 跟随），不生成标题。

## 窄屏（2026-09-19 补）

- ≥1024 展开 260（可拉伸）；**768–1023 强制收缩 56**（右缘拖拽禁用）；**<768 强制收缩 56**，hover flyout 复用既有收缩态机制（**不引入抽屉 / 汉堡**）。断点总表见 ui-design §4。

- **端口（③）**：子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），绑定 127.0.0.1，具体值由 `#15` 挂载表定；本插件不自开对外端口。

## 跨插件登记（2026-09-19 补）

- **#11 session（版本提升：被提升方）**：新增能力方法 **`session.select`**（切 `current` 到目标会话）、**`session.delete`**（会话级软删：条目移出 `conversations` / 标 `deleted_at`，**消息 def 保留不回溯**）、**`session.restore`**（撤销删除）、**`session.branch`**（从某消息分叉新会话）；新增槽 kind `session.select` / `session.delete` / `session.restore` / `session.branch`（写 `#1`，per-thread 键控）。
- **#15 ui-shell**：删除撤销 toast 走 `api.toast({tone,action})`；终止走 `/api/cancel`。
- **#46 ui-threads**：侧栏状态角标与顶栏标签**共用同一份线程状态**（#11 `status` / `pending`）；分工 = 顶栏管「当前父会话内切换」、侧栏管「跨会话全局运行态」，不重复。
- **#39 ui-approval**：待审批角标与 dock 计数同源（`approval.pending`），侧栏只做「哪个会话有」、dock 做裁决。
- **#49 session-title**：自动标题（首条用户消息 + 用户配置的模型 + ≤10 字）；标题落账发 `thread.updated`，本插件只显示、不生成。

- 共用契约见`docs/plans/ui-design.md` §15「UI 插件化契约」；全局 UI 设计语言见 `docs/plans/ui-design.md`。
