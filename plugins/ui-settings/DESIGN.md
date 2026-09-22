# #17 `ui-settings`（引导页 + 设置）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 17 / `ui-settings` |
| 职责 | S1 首次引导（厂商模板 / 自定义厂商，同一流程）+ S7–S13 设置模态（通用 / 模型 / 插件 / 技能 / **记忆** / **编排** / 关于）；**另持编排健康判定 term 与回滚入口**（必须在 #33 之外，见 S13） |
| 依赖 | `->` 12（pins：`model.vendors` / `model.discover` / `model.profile` 的入口 term 发 eff）、**24（pins：`secrets.list`，S8 引用名状态；入口 = 只读命令 `secrets.status`）（2026-09-20 修订）**；**版本提升（被提升方）**：**2026-09-21 升代已完成**——pins 增 `retrieval`（`memory.search`）/ `memory-maintenance`（`memory.view` / `memory.edit`），`memory.*` 三条命令同批加入（否则 `unresolved_cap`）；#22 / #23 已实现，pins 可解析；`+` 1（入口 term 读 `model.probe` 槽）、**2、3、21（S12 记忆本体 / 索引投影读，入口 term 装配）**（2026-09-20 修订）、**33（投影读 `graph` / `nodes` / `thresholds`，S13 只读视图与健康阈值）**、**35（投影读人格名）**、**43 `evolution`（投影读 `trace` / `verdicts` / `proposals` / `evidence`）**；`~` 2（`config.read`）、`notify.state`（按名，归 #38 声明；S7 权限状态唯一来源）（2026-09-20 修订）；**订阅 `api.uiState` 的 `boot_mode`（壳判「无配置」置 `onboarding` → 进引导；写者 #15）/ `settings_open`（设置模态开合；写者 #16）**（2026-09-20 修订）；写 = 客户端直写 2 或入站面直提 `set_active`（S13 回滚）；`<-` 15（挂载） |
| 成员 | execute, terms |
| 能力类·方法 | `implements: ["ui-settings"]`，`methods: {"ui-settings":["ping","vendors","profile","discover","health","view","search","edit"]}`（`ping` 健康占位；`vendors` / `profile` / `discover` 为模型命令的服务侧装配 + 桥接，`health` 为编排健康判定，`view` / `search` / `edit` 为记忆命令的服务侧装配 + 桥接；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | `model.vendors`、`model.discover`、`model.profile`（无参）；**`secrets.status`（无参，只读；入口 term eff #24 `secrets.list`，S8「已读到 / 未读到」数据源——#24 侧已登记）（2026-09-20 修订）**；`memory.view`（无参）、`memory.search`（args `{query, workspace?, tags?, limit?, ids}`；`ids` = UI 侧 `settings.identities` 取回的投影，见「服务侧装配与桥接 · 通则」）、`memory.edit`（**写类无参命令**：载荷先写 `#1` 槽 kind `memory.edit`（字段 id / action / layer / patch），入口 term 读槽 + `#3`/`#21` 投影 → eff #23；§1.14 总表）（2026-09-21 升代：与 `retrieval` / `memory-maintenance` pins 同批加入）；**`orchestration.health`（无参，S13 健康只读视图：入口 term 读 #43/#33 投影，服务判定后回结构化健康状态；不发 eff、不写世界、不发 event——`orchestration.unhealthy` 事件由 #44 自动发）（2026-09-21 修订：判定从 term 下沉到本插件 execute 服务）** |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 见下方 S1 与设置项；连接实例与模型目录一律落 `#2 config`；记忆读写经 22 / 23（不直写 #3 / #21）；**进引导 / 开设置经 `api.uiState`**（订阅 `boot_mode === 'onboarding'` 进 S1，`settings_open` 同步模态开合，见 `plugins/ui-shell/DESIGN.md`「跨 slot 视图状态」；写者已闭环——#16 写 `settings_open` / #15 写 `boot_mode`）（2026-09-20 修订） |
| 边界 | 不做：对话视图 / 判定 / 存密钥（只存 `auth_ref`）/ 记忆本体与维护（归 3、19、21–23）；**服务不读投影**（入口 term 读投影后随 args 传入）、不写世界（写走入站面）、无 pins 不发 eff；服务对 `model` / `retrieval` / `memory-maintenance` 的调用走宿主反向调用（`port.call`，按 `pins` 路由） |
| 验收 | 1) 无配置时强制 S1；2) 模板与自定义同一流程都能完成配置并立即对话；3) 设置即时生效且可回放；4) 插件页只读正确；5) 勾选模型后档案元数据落 config 且可回放；6) 记忆 tab 能浏览 L1 / L2 / L3、搜索、编辑 / 删除 / 置顶，且写经 #23 计划可回放；7) **S13 健康判定在 #33 图坏掉时仍可用**（本插件服务独立于 #33，判定住本插件 execute 服务）；8) **回滚按钮能把 #33 指回上一数据世代**且回滚后编排恢复；9) 回灌缺失时只显「回滚未验证」，不显「成功」；10) **只读页有加载 / 空 / 错误三态、失败可重试、无空白页**；11) **`Esc` 关闭模态且焦点归还打开按钮、层级用 `--z-modal`、语言行置灰只读** |
| 状态 | 已定；厂商模板 6 家全填（各自 `sdk` 标识；**仅 Google 走 SDK 包，其余走三协议自实现**）；**2026-09-19 改版：模板与自定义统一为 URL 驱动流程**；**新增 S12 记忆 tab**（22/23 pins 为版本提升，v1 不 pin）；**新增 S13 编排 tab + 编排健康判定 + 回滚入口**（编排健康事件 emitter 已移交 #44 `evolve-metrics`，S13 为只读视图——提出方登记见 `plugins/evolve-metrics/DESIGN.md`）；**2026-09-21 装配下沉**：模型命令的 bag 装配与编排健康判定从 term / 浏览器下沉到本插件 execute 服务（`methods.ts`），入口 term 只读投影随 args 传入——term 语言无对象构造 / 无算术（`docs/kernel.md` §十三），装配无法用 term 表达；**2026-09-21 S12 升代**：pins 增 `retrieval` / `memory-maintenance`，`memory.view` / `memory.search` / `memory.edit` 三条命令与真实记忆 tab 落地（H21 自能力路由已闭合，见「服务侧装配与桥接」） |

**S1 统一流程（模板 / 自定义只是预填来源不同）**

```
( 厂商模板 )  ( 自定义厂商 )
厂商 [ DeepSeek v ]   地址 https://api.deepseek.com/v1（预填可改）   密钥引用 [ DEEPSEEK_API_KEY ]
（自定义）协议 [ openai-chat | openai-responses | anthropic-messages ]   地址 [ … ]   密钥引用 [ … ]
[ 获取模型 ]   搜索 [ … ]
[x] model-a …   [x] model-b …          ← #12 discover 按 URL 拉取，默认全选，可取消
默认模型 [ model-a v ]    [ 完成并进入 ]
```

- **获取模型** = 写槽 `model.probe`（url / auth_ref）+ 命令 `model.discover`（#12 按 URL 拉列表）。
- **完成并进入** = 客户端直写 `#2 config`：`providers.<vendor>` 写入连接实例（`base_url` / `auth_ref`）+ 用户勾选的 `models`；再调 `model.profile` 拉 models.dev 补 `context_window` / `max_output` / `reasoning` / `modalities`（#12 返回计划落 config）。
- **模板与自定义同一流程**：模板只从 `#4–10` 预填 `default_base_url` / `default_auth_ref_name`，保存后一律落 config；自定义无预填、全手填。
- 整页居中列最大宽 640，实色 `--c-surface` 卡片（引导页不用薄玻璃——薄玻璃全局仅 ui-approval dock 一处，见 ui-design §6）。

**视觉细节（2026-09-18 逐插件定案）**

- **左侧 tab**：160px sticky；tab 行高 34、ghost 五态（§9）；选中 = `--c-selection` 底 + 字重 600，无竖条无彩色；**七页图标** 16px linear：通用 settings / 模型 cpu / 插件 puzzle / 技能 sparkles / 记忆 brain / 编排 git-branch / 关于 info；tab 切换内容区 150ms 淡入不滑动。
- **内容区排版**：行式无分隔——label 14px 左、控件同行右对齐，行距 16；分组名 12px `--c-text-3`、组距 24；无分隔线、无组卡片；内容区独立滚动（模态壳不滚）。
- **S7 主题三卡片**：小卡（`--c-surface` 底、`--radius-md`、居中 sun / moon / monitor 20px linear 图标 + 12px 名称）；选中卡 = 1.5px accent 描边 + 右上角 check 小图标（选中态用描边不用底色，与列表 selection 语义区分）；hover 底色升一级；点击即时生效（实时预览即所见）。
- **S8 密钥引用**（2026-09-19 扩）：引用名 + **密钥输入框**（写入经宿主入站 `secrets.put` → 用户本地文件，**不进世界、不进导出、不进审计**）+ 「已读到 / 未读到」= 6px 语义点（success / danger）+ 12px 文字——三重编码红线（§11）；输入框只显掩码、不回显本体。**「已读到 / 未读到」数据源 = 只读命令 `secrets.status`（入口 term eff #24 `secrets.list`；返回 `{name,has}`；#24 只回「有没有」，不回本体——#24 侧已登记）**（2026-09-20 修订）。
- **S7 配置导入 / 导出**：ghost 按钮 + download / upload 图标；导出 = `config.read` -> 下载 JSON；导入 = 读 JSON 文件 -> 写入端按 schema 校验 -> `put` + `add_gen` 直写 2；导入失败落行内 danger 文字（不弹窗），成功 150ms 行高亮。
- **等待态**：「获取模型」→ 按钮内等待态（disabled +「获取中…」+ 16px 呼吸环，§10）；失败落行内 danger 文字，不弹窗。
- **保存反馈**：即时保存 + 150ms 行高亮（已锁）；高亮 = 行底色 selection 淡入淡出，无文字提示。

**设置模态**（弹窗、**非页面跳转**，2026-09-18 复核）：视口居中，宽 `clamp(640px, 65vw, 1120px)`（约占主界面 60–70%）、最大高 `86vh`、遮罩 `.28`、焦点陷阱、左侧 tab 导航 160px（sticky，右侧内容区独立滚动）、`--shadow-pop`、`--radius-md`；出入场 150ms 淡入 + 2px 上浮，tab 切换内容区 150ms 淡入不滑动。**窄屏（2026-09-19 补）**：**<768 改全屏** `100vw × 100vh`（去 640 下限，避免溢出），左 tab 收为顶部横排可横滚；断点总表见 ui-design §4。**关闭与焦点（ui-design §16.2）**：`Esc` 关闭、点遮罩关闭、关闭时焦点**归还打开按钮**；层级 `--z-modal`（60：在 lightbox 之上、**toast(70) 之下**——ui-design §16.11 已修正）（2026-09-20 修订）；同屏最多一个模态级遮罩。

**已知项：`settings_open` 关闭不复位（登记，待设计层补）**

- `closeOverlay` 只切 `state.mode`，**未把 `api.uiState` 的 `settings_open` 复位为 `false`**；模态关闭后该键恒为 `true`，后续「无变化」写入可能被壳误判为已开。
- 键空间与写者表（ui-design §15「`api.uiState`」）规定 `settings_open` 的**写者 = #16 `ui-sidebar`**；本插件（#17）为**消费者**，按订阅同步模态开合，不越权写他者键。
- **需设计层补**：`settings_open` 的关闭路径与写者归属——或由 #16 补「关闭」写入，或把该键改为 #17 自持（写者表相应改写）。补上之前本插件不擅改键空间，仅在本文登记。

**加载 / 空 / 错误态（2026-09-19 补，统一走 ui-design §10）**

- **只读页首载**（S9 插件 / S11 技能 / S12 记忆 / S13 编排）：内容区居中呼吸条；**>8s 追加「仍在读取…」**；失败 → 行内 danger 条 + [重试]，不弹窗、不空白。
- **空态**：无插件 / 无技能 / 无记忆 / 无编排台账 → 统一空态（图标 + 「暂无…」+ 说明，§10 空态规范）；**S12 搜索无结果显示「无匹配」**（已有）。
- **导入**：导入中 = [导入] 按钮内等待态（§10）；失败行内 danger（已有）；成功 150ms 行高亮（已有）。
- **S1 完成并进入**：写 config + 拉 `model.profile` 期间按钮内等待态（「完成中…」），失败行内 danger + 可重试，**不阻塞已填表单**。
- **语言行**：多语言切换机制后置（§14），当前行**置灰只读** + tooltip「多语言切换后置」（§16.1），不给出无效可点控件。
- S7 通用：主题三卡片（日间 / 夜间 / 系统）、语言（**多语言切换机制后置，见 ui-design §14；当前行只呈现、切换策略未定**）、**通知分组**（通知开关，写 `2.ui.notify`，键含 `approval_pending`/`run_finished`/`run_failed`/`model_error`/`disconnected`/`orchestration_change`/`plugin_write`/`orchestration_unhealthy`/`question_pending`/`only_when_unfocused`；**另含浏览器通知权限状态（2026-09-20 修订）**——经 `api.command('notify.state')` 取（#38 headless 是权限事件源——#38 侧已登记消费者）；**不直接读 `Notification.permission`**：`granted` 显 success 点「已授权」、`default` 显灰点 + **[请求授权] 按钮**（用户手势触发 `Notification.requestPermission()`）、`denied` 显 danger 点 + 指引「请在浏览器站点设置中允许通知」；**未授权 / 已拒绝时通知开关置灰**，详见 `plugins/ui-notify/DESIGN.md`「浏览器通知权限」）、配置导入 / 导出；即时保存 + 150ms 行高亮。
- S8 模型：**上区 = 已保存的模型厂商**（读 `#2 config.providers`，可增删改、重拉档案、切默认模型）；**下区 = 厂商模板 + 自定义厂商**（新建入口，与 S1 同一流程）。**厂商模板按该厂商 SDK 连接；自定义厂商选三基础协议**（`openai-chat` / `openai-responses` / `anthropic-messages`），协议存入 config 后按其连接。表单含厂商 / 地址 / 密钥引用 + [获取模型] + 勾选列表 + 默认模型；另含推理强度、temperature、max tokens（写 config `params`）。
- S9 插件（只读）：身份名 + 状态 + 世代短哈希 + pins 摘要。**人可见只读**；agent 的插件管理路径是 `#42 plugin-admin`（见 `plugins/plugin-admin/DESIGN.md`），不经本页。
- S10 关于：版本、宿主地址、插件数（**2026-09-18 移除「链头 seq」**——账本是内核机制，前端不渲染，见 ui-design §14）。
- S11 技能（#36 的写入入口）：技能列表 + 新建 / 编辑 / 启停（客户端直写 `put` + `add_gen`）。
- S12 记忆（记忆族只读 + 有限写入口，2026-09-19 新增）：三档 —— **L1 会话摘要** / **L2 工作区累积** / **L3 长期条目**；每条显示摘要字段（goal / decisions / facts / open_questions / files）、来源（`source` / `session` / `workspace`）、`at`、**L1 剩余 TTL**、tags。
  - **浏览**：`memory.view`（eff #23，读 `#3` L1/L2 + `#21` L3 元数据）；分档 tab + 工作区筛选。
  - **搜索**：`memory.search`（args `{query, workspace?, tags?, limit?, ids}`；服务装配 #22 `retrieval.search` 真实 bag：`query` / 本会话 L1 goal / `workspace` / `retrieval`（tags、`top_k`=limit）/ `memory={body,refs}`）；命中高亮，空结果显示「无匹配」。
  - **编辑 / 删除 / 置顶**：`memory.edit`（**写类无参命令**：载荷先写 `#1` 槽（kind `memory.edit`，字段 id / action / layer / patch）→ 调无参命令 `memory.edit`；入口 term 读槽 + `#3`/`#21` 投影 → eff #23（§1.14 总表——与 #1/#23 侧一致）；删除走 `sweep` 同路、可回放）（2026-09-20 修订）；置顶 = 提高该条在 L2/L3 容量淘汰中的权重。
  - **写不直连本体**：一律经 #23（去重 / 可回放），#17 不直写 `#3` / `#21`。
  - 视觉：与 S11 同路（行式、行高 34、五态、行内 danger）；tab 图标 `brain` 16px linear；L1 过期行以 `--c-text-3` + 剩余时间弱化显示。
- **S13 编排（#33 的只读视图 + 回滚入口，2026-09-19 新增）**：四个区。
  - **图**（只读）：当前 active 图的节点/边列表（`contract_id` + `impl` + `node_index`；边显 `when` 判定名）。
    **不做图形化编辑器**：图变更一律经 agent 提案 + 审批（`orchestration-admin`），本页只呈现。
  - **Scope 名录**（只读）：每个 Scope 显 `contract_id` / 人格名（读 `#35` 投影）/ `scope`（全局 / 工作区名）/
    `autonomy` / `links` 摘要 / 滚动成功率。**这是"跑了哪个子代理"的人可读入口**（轨迹里的 `chosen_agent` 在此显名）。
  - **编排健康**（本页核心，见下「健康判定与回滚」）：连续失败计数 + 最近失败拒绝码分布 + **[回滚到上一世代]**。
  - **进化台账**（只读）：**#43 `evolution`** 的 `verdicts` / `proposals` / `evidence` 三条 tail 倒序列表
    （判定含 `proposal_id` + `evidence_id`，可逐级下钻到 `trace`）。**采纳与拒绝都显示**——只看采纳就看不出被拒过什么。
  - 视觉：与 S9 插件页同路（行式只读、行高 34）；tab 图标 `git-branch` 16px linear；
    健康异常时该 tab 标签右侧挂一个 warning 小圆点。

### 健康判定与回滚（写死：判定必须住本插件，不住 #33）

**为什么在这里而不在 #33**：`#33` 的图若被改坏，**改回去的入口也在图里** ⇒ 自锁。
所以「连续失败」判定与回滚触发**必须在图外**，而 #33 之外唯一同时满足"能读投影 + 有 UI"的是本插件。
宿主也不行——让宿主在连续失败时自己走 #33 的 fallback 等于**宿主认识 #33 的业务**，破「载体不认识业务」。

- **判定 = 本插件的 execute 服务**（`execute/methods.ts` 的 `judgeHealth`，纯函数、可重算）：入口 term 读 **#43** `evolution` 投影与 **#33** `loop-policy`（阈值 / 世代）后随 args 传入，服务数最近连续以 `refused` 收口的回合数，与 `#33 thresholds` 里的阈值比较 ⇒ 回结构化健康状态（连续计数 / 阈值 / 拒绝码分布 / 健康态 / 回滚目标）。**本插件不 pin #33 也不 pin #43**，只投影读（按字面身份名读投影不是依赖边）。**该「连续 N 次 refused」口径与 #44 `orchestration.unhealthy` 的判据同源**（#44 周期 `aggregate` 也用连续收口计数，不再用 `failure_cluster` 窗口计数）。判定下沉到服务（而非 term）的理由：内核 term 语言无对象构造、无算术（`docs/kernel.md` §十三），装配 bag / 计数比较无法用 term 表达；判定仍**住本插件、不住 #33**（图被改坏时回滚入口不能也在图里）。
- **`orchestration.unhealthy` 事件的 emitter = #44 evolve-metrics 服务**（2026-09-19 修正）：#44 **周期（宿主定时触发）`aggregate`** 按连续 N 次 `refused` 收口计数超 #33 阈值时**自动发**该事件，不依赖用户打开 S13。本插件的 `orchestration.health` 命令降为**只读视图**（用户打开 S13 时读 #43/#33 投影渲染健康状态 + warning 横幅；本插件不 `+ 44`）（2026-09-20 修订），不再发事件——解决「无人打开 S13 则通知永不触发」的断链。
- **回滚 = 入站面直接提交 `set_active`**（指回 `#33` 上一个数据世代）：
  `host.md` §落账 已允许发起者在入站面直接提交 directive ⇒ **零宿主改动、零新动词**。
  回滚按钮走**二次确认**（同 S8 删厂商），确认后提交并刷新健康；**提交中** = 按钮内等待态（§10），**失败** = 行内 danger + [重试]，不弹窗。
- **回滚后必须可验**：回滚后同输入重跑，在**审计回灌**下应逐字节复现旧结果；
  回灌缺失时本页只能显示「回滚未验证」，**不得**显示「回滚成功」。

- **膨胀点提示**：S11 技能 + S12 记忆 + S13 编排已让 17 从「配置」扩到「数据编辑 + 运维」；
  若继续长大，拆出 `ui-skills` / `ui-memory` / `ui-orchestration`（当前仍留 17，避免多身份与多挂载）。
  **但 S13 的健康判定与回滚入口不可与 #33 合并**（上文理由），拆分时也必须留在 #33 之外。

### 服务侧装配与桥接（2026-09-21 修订）

**为什么下沉到服务而不在 term**：内核 term 语言只有八个原语，**无对象 / 列表构造、无算术**
（`docs/kernel.md` §十三），因此「读多个投影切片拼成 bag」「数连续 `refused` 并比阈值」无法用 term 表达。
故 `model.vendors` / `model.profile` / `model.discover` 的入参装配与 `orchestration.health` 的判定
一律住本插件 `execute/methods.ts`：

- 入口 term 只读**最窄的 ctx 投影**并作为 eff args 传入；服务**不读投影**。
  `model.discover` 只需输入身份 body（读 `ctx.ids.input.body`）；`model.vendors` / `model.profile` /
  `orchestration.health` 需同时读多个身份（厂商模板 / config + 厂商模板 / 台账 + 阈值 + 世代），
  而 `eff` 的 args 是**单一 Term**、term 又无对象构造，无法把多个投影切片拼成一个值，故这三条读整份
  `ctx.ids`（服务侧再按名取用）。
- 服务装配后经**宿主反向调用**（`port.call`，`docs/protocol.md` §2.4）调 `model` 端口（`pins.model`），
  或直接判定回结构化结果；返回计划（`$directives`）或结果值，命令结果即 `model.*` 的结果 / 健康状态。
- `model.discover` 的 `model.probe` 清槽由**服务返回的计划**携带（不再由客户端或入口 term 清）——
  `plugins/input/DESIGN.md` §读取契约已同步。

**通则（入口 term 不能装配多切片 bag ⇒ 装配下沉到服务）**：`eff` 的 args 是**单一 Term**，内核 term 语言
只有八原语、**无对象 / 列表构造**（`docs/kernel.md` §十三），因此**无法把多个投影切片（或命令 args 与投影）
拼成一个值**。凡一条命令需同时读多个投影切片（或同时要 args 与投影），入口 term 一律只传**单一投影切片**
（最宽到整份 `ctx.ids`），装配 / 分支 / 切片 / 合并全部住 `execute/methods.ts`；服务**不读投影**。
- `memory.view` / `memory.edit`：入口 term 传整份 `["g",["ids"]]`，服务按名取 `#3` / `#21` / `#1` 装配 #23 的 args。
- `memory.search`：命令 args（`query` / `workspace` / `tags` / `limit`）与投影无法在 term 合流，改由 UI 侧
  `settings.identities` 取回 `ids` 随 args 传入（args 内含 `ids`），入口 term 传 `["v",0]`（命令 args）；
  服务按 #22 真实 bag 形状（`query` / `goal` / `workspace` / `retrieval` / `memory={body,refs}`）装配后反向调
  `retrieval.search`。**长期解**：内核补齐对象 / 列表构造（`docs/kernel.md` §十三「装配模板」）或 #1 增
  `memory.search` 槽 kind 后，可回到「入口 term 传投影 + 查询走槽」的单通道形态。

**自能力路由（H21，2026-09-21 第三批已闭合）**：宿主 `eff` 的 `port` 现**允许解析到发出者自身声明的能力类**
（`packages/host/effect/route.ts` 自能力分支 + `packages/host/effect/test/rounds.test.ts` 覆盖）。
故入口 term eff 到本插件自己的能力类 `ui-settings` 已可用——`model.vendors` / `model.profile` /
`model.discover` / `orchestration.health` 与 **2026-09-21 升代新增的 `memory.view` / `memory.search` /
`memory.edit`** 全部经此触发本插件服务，**不再以 `eff_error` 收口**。**无需自 pin**：自 pin 在首次 seed 报
`unresolved_pin`、重 seed 因 pins 自环被隔离（`dep.cycle` → `not_loaded`），仍不是可行解。

## 跨插件登记（2026-09-20 修订）

- **#24 secrets**：本插件只读命令 `secrets.status`（入口 term eff `secrets.list`，S8「已读到 / 未读到」数据源）——双侧登记。
- **#38 ui-notify**：`notify.state` 消费者（S7 经 `api.command('notify.state')` 取浏览器权限状态，不直接读 `Notification.permission`）。
- **#1 input**：`memory.edit` 槽 kind（写类无参命令，载荷先入槽）——#1 侧已登记。

- **slot / 端口（③）**：slot = `overlay`（设置模态 / 引导页）；子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），绑定 127.0.0.1，具体值由 `#15` 挂载表定。
- 共用契约见`docs/plans/ui-design.md` §15「UI 插件化契约」；全局 UI 设计语言见 `docs/plans/ui-design.md`。
