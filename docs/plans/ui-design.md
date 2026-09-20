# 全局 UI 设计语言（tokens.v1）与 UI 插件化契约

> 本文是 `plugins/ui-*/DESIGN.md` 与 `docs/plans/draft-design.md` 所引用的 **UI 契约 + 全局设计语言**的**唯一权威**。
> §1–§14 = 设计语言（token 取值与理由），落地物为 `ui-shell` 的 `GET /assets/tokens.v1.css`（token 唯一来源）。
> §15 = **UI 插件化契约**（slot 应用 / headless 两档、布局槽与纵向顺序、挂载表与反代、子应用入口、事件、失败隔离）；框架层插件契约见 `docs/plugins.md`。

## 0. 已定基调（2026-09-18 决策）

| 决策 | 结论 |
| --- | --- |
| 色调基调 | 暖中性·纸感，但**只沾一点暖**：灰阶带轻微暖偏（hue 30–60，饱和度 ≤4%），主体仍是中性灰；深色模式进一步压回中性，避免泛黄发脏 |
| 字体策略 | 系统字体栈，不自托管 webfont（单人本地工具，本平台渲染即唯一现实） |
| 强调色 | 低饱和靛蓝（避开 warning 琥珀色相，防止语义冲突）；单屏出现面积 ≤5%，仅用于「当前选中项」与「发送键」 |
| 排版路线 | 紧凑、不用大字风格（各插件 DESIGN.md 已锁的数值全部收编为 token，见 §12） |
| 圆角 | 整体收小：3/6/8/10（2026-09-18 用户定「不要太圆，稍微带点」），**取代**此前各插件锁定的 4/8/12/14 |
| 图标风格 | **线性**单色 linear（Lucide 按需子集，描边 1.5px，sprite 唯一来源）；整屏保持干净，禁面性 / 双色 / emoji |
| 聚焦与悬停 | 生命感 = 即时反馈 + 短过渡，不常驻动画：输入卡聚焦「描边加深 + accent 8% 淡色阴影环」150ms **一次性淡入**；所有可点元素有 hover / active 底色级差 |
| 明确不做 | 审计/账本/重放可视化、实验插件 UI、快捷键体系——见 §14 |

## 1. 设计原则

1. **克制**：层次靠间距与字重（400/600 两级），不靠字号、阴影与彩色。页面内零阴影，仅锚定弹层一级阴影。
2. **紧凑**：正文 14px、行距 22、消息间距 16；无 ≥20px 的展示型大字（产品名 18 封顶）。
3. **透明即信任**：权限动作（审批、错误、终止）必须可见且视觉权重高于普通内容——左侧 3px 语义色竖线是统一的「需要你注意」语言。
4. **尊重注意力**：生成中用呼吸条，禁止闪烁动画、禁止常驻红点。

## 2. 颜色 token

命名 `--c-*`。暖偏控制：浅色底/面为 hue≈40、饱和度 2–4% 的近中性灰；深色为 hue≈40、饱和度 ≤3%。

### 浅色（默认）

| token | 值 | 用途 |
| --- | --- | --- |
| `--c-bg` | `#FAFAF9` | 页面底 |
| `--c-surface` | `#FDFDFC` | 卡片 / 输入卡 / 弹层底（不用纯白） |
| `--c-sidebar` | `#F5F5F3` | 侧栏底（与 main 以底色差分层，无边框也可） |
| `--c-selection` | `#ECECEA` | 当前会话项 / hover 底 |
| `--c-border` | `#E3E2DF` | 1px 边框 |
| `--c-text` | `#1F1E1C` | 正文（不用纯黑） |
| `--c-text-2` | `#6E6D69` | 次级文字、脚注 |
| `--c-text-3` | `#9C9B96` | 占位符、禁用 |
| `--c-accent` | `#46548C` | 选中描边 / 发送键底（对 `--c-surface` 对比 ≥4.5:1） |
| `--c-accent-text` | `#FFFFFF` | 发送键字 |

### 深色

| token | 值 | 用途 |
| --- | --- | --- |
| `--c-bg` | `#171615` | 页面底（非 #000，减少涂抹感） |
| `--c-surface` | `#1E1D1B` | 卡片 / 弹层 |
| `--c-sidebar` | `#141312` | 侧栏 |
| `--c-selection` | `#2A2927` | 选中 / hover |
| `--c-border` | `rgba(255,255,255,.10)` | 白色 overlay 边框（随底色自适应，不用实色） |
| `--c-text` | `#E8E6E3` | 正文 |
| `--c-text-2` | `#A3A19B` | 次级 |
| `--c-text-3` | `#6F6D68` | 占位 / 禁用 |
| `--c-accent` | `#8E9BD4` | 选中 / 发送键 |
| `--c-accent-text` | `#1A1A24` | 发送键字 |

### 语义色（浅 / 深各一组，仅「前景 + 底」两个 token）

| 组 | 浅色前景 / 底 | 深色前景 / 底 | 用途 |
| --- | --- | --- | --- |
| danger | `#B4342A` / `#F7E9E7` | `#E88A80` / `rgba(232,138,128,.12)` | 内联错误条、全部拒绝、终止 |
| warning | `#9A6B15` / `#F5EDDC` | `#D9AE5B` / `rgba(217,174,91,.12)` | severe 档、降级提示 |
| success | `#3E7A4E` / `#E7F0E9` | `#7FC795` / `rgba(127,199,149,.12)` | 已批准、连接正常 |
| info | `#46548C` / `#E9EBF4` | `#8E9BD4` / `rgba(142,155,212,.12)` | system 灰条升级、提示 |

规则：底色一律低透明或低饱和浅底；竖线 / 图标用前景色；**任何对比组合须过 AA（正文 ≥4.5:1）**，深色底上的语义前景已按此调亮。

> **「终止」语义分工（防歧义）**：**进行中的终止键**保持发送键 accent 底 + square 图标呼吸（§10，**禁红**）；danger 只用于**终止 / 取消的结果标注**（「已取消」字、内联错误条、[全部拒绝]）与破坏性动作。即「动作进行中不用 danger，结果与破坏性动作才用 danger」。

## 3. 字体 token

```
--font-sans: -apple-system, "Segoe UI", "PingFang SC", "HarmonyOS Sans SC",
             "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;   /* 简繁中英全覆盖 */
--font-mono: "JetBrains Mono", "Cascadia Code", Consolas, "Sarasa Mono SC", monospace;
```

| token | 值 | 用途 |
| --- | --- | --- |
| `--font-size-xs` | 12 | 脚注（模型·用量·计数）、最小值，**不得再小** |
| `--font-size-sm` | 13 | 代码 |
| `--font-size-md` | 14 | 正文（全局默认） |
| `--font-size-lg` | 16 | 面板小标题 |
| `--font-size-xl` | 18 | 产品名（封顶） |
| `--leading-body` | 22 | 正文行距（14/22） |
| `--leading-code` | 20 | 代码行距（13/20） |
| `--weight-regular` / `--weight-strong` | 400 / 600 | 仅两级，禁 300 与 700+ |

数字类脚注（用量、计数、世代哈希）加 `font-variant-numeric: tabular-nums`。

## 4. 间距与布局 token

`--space-*`：4 / 8 / 12 / 16 / 24 / 32（8px 网格，4 为半步）。**禁止刻度外取值**。

| 布局 | 值 |
| --- | --- |
| 侧栏宽 | 展开 `--sidebar-w-expanded: 260` / 收缩 `--sidebar-w-collapsed: 56` / 拉伸范围 `--sidebar-w-min: 220` – `--sidebar-w-max: 420`（<1024 强制收缩 56、不可拉伸） |
| 会话列表项高 | 34 |
| 消息间距 | 16；消息列最大宽 720，居中 |
| 用户气泡最大宽 | 72% |
| 设置模态 | `clamp(640px, 65vw, 1120px)` × ≤86vh，左导航 160 |
| 引导页列宽 | ≤640 居中 |

### 响应式断点（2026-09-19 补）

| 断点 | 侧栏 | 消息列 | composer | 设置模态 | dock |
| --- | --- | --- | --- | --- | --- |
| ≥1024 | 展开 260（可拉伸） | ≤720 居中 | 全工具栏 | `clamp(640px, 65vw, 1120px)` × ≤86vh | 紧贴输入卡、全宽 |
| 768–1023 | **强制收缩 56**（不可拉伸） | 全宽 − `--space-16` 边距 | 全工具栏 | 同左 | 全宽 |
| <768 | 强制收缩 56，hover flyout 复用既有收缩态机制 | 全宽 − `--space-12` 边距 | 全工具栏（<480 仅图标，见 ui-composer） | **全屏** `100vw × 100vh`：去 640 下限，左 tab 收为顶部横排 | 全宽 |

- 断点只改布局，不改组件形态与 token；**窄屏不新增抽屉 / 汉堡等机制**（<768 侧栏 = 既有收缩态 + flyout，不引入第二套交互）。
- 窄屏下 `main` 消息列由「居中列」退化为「占满」，工具卡 / 群聊气泡的宽度上限随之解除。

## 5. 圆角 token

| token | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 3 | 按钮、badge、竖线条 |
| `--radius-md` | 6 | 列表项、代码块、卡片 |
| `--radius-lg` | 8 | 用户气泡 |
| `--radius-xl` | 10 | 输入卡 |

> 2026-09-18 收小：原 4/8/12/14 → 3/6/8/10，「微圆、不显眼」；各插件 DESIGN.md 同步改写，禁止再引用旧值。

## 6. 边框与层级

- 分层手段优先级：**底色差 > 1px 边框 > 阴影**。
- 全页面仅一处阴影 token：`--shadow-pop: 0 4px 16px rgba(0,0,0,.10)`（浅）/ `rgba(0,0,0,.40)`（深），只给锚定弹层（模型 / 推理强度 / 权限档下拉）与设置模态。
- **薄玻璃（全局唯一例外，仅 ui-approval dock 停靠带）**：`--c-glass` = 浅 `rgba(253,253,252,.82)` / 深 `rgba(30,29,27,.84)` + `backdrop-filter: blur(12px)`；底色不透明度 ≥80% 保证带内文字 AA；不支持 backdrop-filter 时降级实色 `--c-surface`。任何其它组件禁止使用 blur / 半透明底。
- 输入卡聚焦（2026-09-18 定，取代 ui-composer 旧口径「聚焦只用灰度描边变化」）：
  - 描边 `--c-border` → `--c-text-3` 加深一档；
  - 外圈淡色阴影环 `box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-accent) 8%, transparent)`；
  - `--motion-base` 150ms ease-out **一次性淡入**至静止，失焦 100ms 淡出——生命感只出现在交互瞬间，聚焦持续期间无任何动画；
  - reduced-motion 下去掉淡入淡出、直接切换；禁止用常驻跑马灯 / 脉冲边框（与「生成中呼吸条」同屏互扰，见 §1 原则 4 与 §9 常驻动画白名单）。

## 7. 动效 token

| token | 值 |
| --- | --- |
| `--motion-fast` | 100ms ease-out（hover、按钮态） |
| `--motion-base` | 150ms ease-out（会话切换淡入淡出、行高亮、列表项出入） |
| `--motion-slow` | 200ms ease-out（dock 停靠带出现 / 消失） |

`@media (prefers-reduced-motion: reduce)` 下全部归 0；呼吸条降为静态低透明度条。滚动贴底 / 上滑冻结逻辑不变。

## 8. 图标规范（linear · 唯一来源）

- 风格（2026-09-18 定）：**线性**单色 linear icon，整屏干净；禁面性填充、禁双色、禁 emoji。
- 来源与分发：Lucide（MIT）按需子集，只收实际用到的图标；打成 `icons.v1.svg` sprite，由 `ui-shell` 与 `tokens.v1.css` 并列服务——图标全局唯一来源；业务插件以 `<use href="/assets/icons.v1.svg#<name>">` 引用，**禁止各自内嵌图标**。
- 网格与描边：24×24 viewBox、全局覆盖 `stroke-width: 1.5`、round cap / round join、图形距边 ≥2px。
- 尺寸两档：`--icon-sm` 16（脚注 / 行内 / 小按钮）、`--icon-md` 20（工具栏 / 侧栏 / 弹层）；不用其它尺寸。
- 颜色：`stroke: currentColor` 继承文字色——默认 `--c-text-2`、hover `--c-text`、选中态 `--c-accent`；不单独着色。
- 初始语义映射（新增图标先登记于此再入 sprite）：发送 arrow-up、终止 square、附件 plus、新对话 pencil、设置 settings、复制 copy、重试 rotate-ccw、展开 panel-left、收缩 panel-left-close、收起滚动 arrow-down、模型 cpu、推理强度 gauge、权限四档 auto=zap / severe=shield-alert / review=eye / deny=ban、批准 check、拒绝 x、全部批准 check-check、断线 alert-triangle、slot 失败 alert-circle、重命名 pencil-line、下拉箭头 chevron-down、待发队列 list、插件 puzzle、技能 sparkles、记忆 brain、关于 info、日间 sun、夜间 moon、系统 monitor、导出 download、导入 upload、附件文件 paperclip、工作区 folder、添加工作目录 folder-plus、在文件管理器中打开 folder-open、折叠箭头 chevron-right、更多 more-horizontal、搜索 search、删除 trash-2、分支 git-branch、撤销 undo-2。
- 可及性：图标按钮必须带 `aria-label`；图标不得单独承载状态语义（配合 §11 红线 2 三重编码）。

## 9. 交互状态规范（生命感 = 即时反馈 + 短过渡）

所有可交互元素五态齐备：default / hover / active / focus-visible / disabled。只过渡 `background-color`、`border-color`、`box-shadow`（§7 时长）；**不用位移、不用缩放、不用弹跳**——沉稳干净的工具感优先，生命感来自过渡曲线的弹性而非图形跳动。

| 元素 | hover | active | focus-visible |
| --- | --- | --- | --- |
| 按钮 / 图标按钮 | 底色升一级（`--c-surface` → `--c-selection`），100ms | 底色再暗一级（`--c-border`） | `outline: 2px solid var(--c-text)`，offset 2px |
| 会话列表项 | `--c-selection` 底淡入，重命名图标同步淡入 | 同上再暗一级 | 同上 |
| 发送键（accent 底） | `filter: brightness(1.06)` | `brightness(.94)` | outline |
| 输入卡 | 描边 `--c-border` → `--c-text-3` | —（点击即聚焦） | §6 聚焦效果 |
| 弹层条目 | 底色升一级 | 暗一级 | outline |
| 回到底部胶囊 | 底色升一级 | 暗一级；点击 150ms 平滑滚动 | outline |

- disabled：`opacity: .45` + `cursor: not-allowed`，取消全部 hover / active 反馈。
- **一次性动画白名单**（瞬时反馈，允许）：输入卡聚焦淡入、弹层出现（100ms 淡入 + 2px 上浮）、设置保存行高亮 150ms、dock 停靠带出入 200ms、会话切换 150ms 淡入淡出（= `--motion-base`，与 §7 一致）、toast 入场、侧栏收缩态 flyout 出入（100ms，hover 意图延时 150ms 出 / 300ms 收）。
- **常驻动画白名单**（仅「呼吸动画族」一个词汇，禁止新增其它类型）：条/环/点三种形态见 §10；生成中呼吸条（>8s 出「仍在生成…」文案）；reduced-motion 下全族降为静态+文字。

## 10. 等待态与状态转换规范

等待词汇统一为**呼吸动画族**（全局唯一常驻动画类型，1.6s opacity 25%↔60% 呼吸循环；reduced-motion 降为静态灰 + 文字）：

| 场景 | 形态 |
| --- | --- |
| 块级加载（会话列表、历史消息首屏、群聊 / 步骤卡首次加载、lightbox 原图、设置只读页 S9/S12/S13） | 容器居中呼吸条（2px 高 × 48px 宽）；**>8s 追加「仍在读取…」**；失败落行内 danger 条 + [重试] |
| 发送后首 token 前 | 消息流底部呼吸条（已锁），>8s 追加「仍在生成…」 |
| 生成中终止键 | square 图标小幅呼吸（发送键 accent 底不变，禁红色） |
| 历史翻页（滚顶拉上一窗） | 列表顶部内联呼吸条（2px × 32px，不遮消息）；**到底显示「没有更多了」**（12px `--c-text-3`），不静默 |
| 会话切换（#18 重拉 `chat.history`） | 主区 150ms 淡入 + 顶部细呼吸条（不遮消息、不整屏遮罩） |
| 按钮内等待（获取模型 / 重试 / 发送中 / 导出 / 添加工作目录的「等待选择…」） | 按钮 disabled + 16px 呼吸环 spinner（1s linear）+ 文字进行式（「获取中…」），完成 150ms 恢复 |
| 断线重连中 | S6 通栏 warning 条（已锁），[重试] 走按钮内等待态 |

**空态规范（统一，禁空白页）**：图标（`--c-text-3`，20px，**可选**——消息流空态用无图标两行变体）+ 一句说明（`--c-text-2`，13px）+ 可选主操作按钮。各空态：无会话（「还没有会话」+ [新建会话]）、无搜索结果（「无匹配」）、无插件 / 无技能 / 无记忆 / 无编排台账（「暂无…」+ 说明）、无待办（不渲染标签位）。**空态不是加载态**——数据未回时先呼吸条，确认空后才出空态。

**红线：禁止静默无限等待**——每个等待态必须有进度文案（>8s）、退出路径（重试 / 终止）或最终落入错误条 / 占位卡（诚实反馈）。

**状态转换细节**（两态之间禁止跳变）：

- 任何视觉状态切换以 100–150ms 底色 / 透明度过渡衔接（时长取 §7 token）。
- 列表项增删（新会话、待审批条目）：新项 150ms 淡入；移除 100ms 淡出 + 高度收起 150ms。
- 发送键「发送↔终止」形变：图标 arrow-up ↔ square 交叉淡化 100ms，按钮尺寸恒定（工具栏不跳动）。
- 设置模态 tab 切换：内容区 150ms 淡入，不滑动。
- 计数变化（待审批 N、待发 N）：数字交叉淡化 100ms。
- slot 子应用就绪：壳内容 150ms 淡入替换启动态（ui-shell 已锁）。

## 11. 社会美学与可及性红线

1. **WCAG 2.1 AA**：所有正文对比 ≥4.5:1、大字与图标 ≥3:1；token 值改动须重验。
2. **三重编码**：状态永不单靠颜色——错误 / 审批档位 / 生成态 = 颜色 + 图标 + 文字（色觉障碍可用）。
3. **图标**：规范见 §8（linear 单色、唯一来源）；**禁用 emoji 作图标**（跨平台不一致、文化偏向）。
4. **最小字号 12**，正文 14；不使用全大写英文长句。
5. **中性包容**：无性别化 / 强文化符号色彩；文案简繁中英随系统语言。
6. **键盘可达**：焦点环用 `outline: 2px solid var(--c-text)`（高对比、非彩色），弹层焦点陷阱（设置模态已定）。
7. **诚实反馈**：终止后保留已生成部分并标注「已取消」；错误码翻译为人话——界面不掩饰系统状态。
8. **低饱和纪律（2026-09-18 用户定）**：禁止一切深色鲜艳色——任何界面元素（图标、按钮、动画、语义色）不得出现高饱和 / 纯相色（如纯红纯蓝）；语义色前景一律低饱和（见 §2 表值），深色主题底不得纯黑；「生成中」浅动态只允许呼吸动画族，不允许鲜艳色闪烁。
9. **动态区域播报（`aria-live`，2026-09-19 补）**：状态变化不止要看得见，也要读得出——纯视觉的流式 / 计数 / 出现即等于对读屏用户静默。
   - **消息流（流式）**：生成中容器 `aria-busy="true"`、**不逐字播报**（避免刷屏）；回合定稿后对整条助手消息以 `aria-live="polite"` **一次性播报**。
   - **审批停靠带**：`role="region"` + `aria-label`，计数「待审批 N」用 `aria-live="assertive"`（闸门级，需立即知会）。
   - **待发计数 / 运行态角标 / 上下文用量**：`aria-live="polite"`、`aria-atomic="true"`。
   - **toast**：info / success 用 `role="status"`（polite）；warning / danger 用 `role="alert"`（assertive）。
   - **S6 断线横幅**：`role="alert"`。
   - 播报文案走 `messages.v1.json`（见 §11.7 / ui-shell），不硬编码。
10. **已知例外（登记，2026-09-19 用户定）**：顶栏 `#46 ui-threads` 为**纯 hover 交互**，键盘不可达（破 §11.6「键盘可达」红线）；触屏 / 无 hover 设备**暂不支持**（§14）。后果：键盘用户与触屏用户**无法经顶栏切换子代理 / 群聊 / 工作流线程**（会话切换仍可经 #16 侧栏）。此例外为已接受取舍，**新增 hover-only 交互前须先登记**。

## 12. 组件 → token 映射（收编各插件已定值）

| 组件 | 已定规格 | 引用的 token |
| --- | --- | --- |
| ui-shell | 侧栏/主区底色差+1px 分隔线；S0 居中字+呼吸条；S6 顶部通栏悬浮 warning 条；slot 失败原地占位卡（手动重试）；**全局 toast（右下角堆叠，§12 注）**；`messages.v1.json` 唯一文案表 | `--c-border`、warning 组、danger 竖线语言、`--motion-base` |
| ui-sidebar | 260/56、分组头 30 / 会话项 34、圆角 6、当前会话 selection 底；顶部 [+ 添加工作目录]；分组头 = chevron+folder+名称+[新对话]+[⋯]；无工作区选择器行；收缩态 hover flyout；**会话项状态角标（运行中呼吸点 / 待审批 warning 点 / 失败 danger 点）+ hover [终止]；会话管理 [⋯]（重命名 / 导出 / 分支 / 删除）+ 双击就地重命名** | `--sidebar-w-*`、`--radius-md`、`--c-selection`、§9 五态、`--shadow-pop`、warning/danger 组 |
| ui-chat | 正文 14/22、间距 16、代码 13/20 圆角 6、用户气泡 selection 底圆角 8 ≤72% 四角一致、助手整宽无底、脚注=复制/重试 hover 淡入（token 用量读 #11 消息 `meta.usage`，模型名不进脚注）、**复制成功图标就地变 check 1.2s**、lightbox 可缩放；**群聊 / 工作流步骤卡（按 `kind` 分派）+ question 交互卡**；**>200 条窗口化 + 「↓ N 条新消息」胶囊** | `--font-size-md`、`--leading-*`、`--radius-md/lg`、`--c-selection`、§10 等待态 |
| ui-composer | 圆角 10、聚焦「描边加深+淡色环一次性淡入」、工具栏 [+][模型][推理强度][权限][发送\|终止] 全部 20px linear 图标+文字；**输入卡下方 12px 上下文用量行 `上下文 42k / 128k`（`context.assembled` 事件，≥75% warning 前景字）** | `--radius-xl`、§6 聚焦规则、§8 图标、accent 仅入发送键、`--font-size-xs` |
| ui-approval | 停靠带紧贴输入卡上方、出入 200ms、薄玻璃唯一例外（降级实色）、max 40vh、单行摘要点击展开（severe 默认展开）、批准 accent / 拒绝 danger 字、**[全部批准] 与 [全部拒绝] 均原地 3s 二次确认**；**等待计时（>2min warning 字）+ `expired` 弱化呈现 + 明确「全部拒绝 = 放弃并终止本回合」** | `--c-glass`、`--shadow-pop`、`--motion-slow`、warning 竖线、§10 |
| ui-settings | 模态 65vw 居中左侧 tab（选中=selection 底+600）、内容区行式无分隔、主题三卡片（图标+名称、选中 accent 描边+check）、配置导入/导出、引导页实色卡、150ms 行高亮；**S7 通知分组含浏览器通知权限状态 + [请求授权]** | `data-theme`、`--shadow-pop`、`--motion-base`、语义点三重编码 |
| **ui-threads** | 顶栏常态 0 高度（overlay，不推挤）；标签：圆角 6、选中=selection 底、运行中呼吸点 / 待审批 warning 点；hover 展开 150ms | `--radius-md`、`--c-selection`、§9 五态、warning 组、`--motion-base` |

> **toast 归属（2026-09-19 定）**：全局轻提示归 **`#15 ui-shell`**（与 S6 断线横幅同级的全局 chrome）——**不占 slot**（壳是壳本体，不占自身 slot），故不破「一插件一 slot」，也不再需要「toast 挂 overlay」这条与 #17 冲突的口径。
> 形态：右下角 `--space-16` 内边距堆叠（最多同屏 3 条，超出排队）；`--c-surface` 底 + 1px `--c-border` + `--radius-md` + `--shadow-pop`（**不用薄玻璃**）；左 3px 语义竖线（tone=info/success/warning/danger）；100ms 淡入 + 2px 上浮；info/success 2.5s 自动消失，warning/danger 4s，**带动作（如「撤销」）时不自动消失**；hover 暂停计时、右上 x 可关；reduced-motion 静态。触发面两路：① 子应用经 `api.toast({tone,text,action?})` 请求；② 壳订阅宿主事件按内置规则发（如断线）。文案走 `messages.v1.json`。

主题切换实现：`ui-shell` 在 `<html>` 上写 `data-theme="light|dark"`，`tokens.v1.css` 内两套值按属性选择器切换；「系统」= 跟随 `prefers-color-scheme`。业务插件只准引用 token，**禁止硬编码色值**。

> headless 前端（ui-notify）不适用本视觉语言：notify 用 OS 原生通知模板（不挂操作按钮）。

## 13. 设计资源验收（tokens.v1.css + icons.v1.svg）

1. tokens 文件仅含 CSS 自定义属性与 `data-theme` 分支、reduced-motion 分支，无组件样式；
2. §2–§8 全部 token（含图标尺寸两档）+ §16.11 的 z-index 栈 token（`--z-*`）在列，命名与本文一致；
3. 任一业务插件替换色值 = 只改本文件即全局生效（ui-shell 验收项「主题 token 生效」的依据）；
4. AA 对比抽查：text/bg、text-2/bg、accent/accent-text、四语义组前景/底、聚焦淡色环在浅/深底上均可感知；
5. icons.v1.svg 仅含 §8 登记的子集 symbol，stroke 1.5 / round cap 全局一致，业务插件中不存在任何内嵌图标或 emoji 图标；
6. 五态抽查（§9）：任一按钮 / 列表项 / 弹层条目具备 hover、active、focus-visible、disabled 反馈，且常驻动画仅「呼吸动画族」一类（§10）；
7. 等待态抽查（§10）：任一加载路径不存在静默无限等待，均有进度文案 / 退出路径 / 错误落地三者之一；
8. 薄玻璃仅出现在 ui-approval dock（§6 唯一例外），不支持 backdrop-filter 环境降级实色生效。
9. 交互细则抽查（§16）：tooltip 不承载关键信息且有 `aria-describedby`（16.1）；弹层 `Esc` 关闭且焦点归位、下拉可键盘选（16.2）；命中区 ≥24×24（16.3）；层级栈无自造 z-index 且 toast 在模态上可见（16.11）；静态资源降级不裸奔（16.14）。
10. 文案抽查（§17）：术语全 UI 一致（会话 / 线程 / 工作区 / 上下文…）、按钮动词规范、错误人话无感叹号 / 不道歉、无 emoji 图标、省略号用 `…`。

## 14. 明确不做与残留待办

**明确不做（2026-09-18 / 09-19 用户定）**

- **审计 / 账本 / 重放的可视化前端**：账本是内核机制、不是产品机制，前端不渲染（`ui-settings` S10 关于页同步移除「链头 seq」）；审计取数面（宿主入站 `audit{filter}`）只服务机制，**不配 UI 插件**（原 `audit` 已撤销，不占编号）。
- **实验 / 评测 / 进化类插件 UI**：原 bench / scorer / monitor / diagnoser / evolve / meta-eval 整簇已撤销，不补 UI、不开面板或页面。
- **快捷键体系**：不做全局快捷键表与快捷键帮助入口（Enter / Shift+Enter / ESC 作为控件行为散点保留，不构成体系）。
- **用户麦克风输入 / 语音输入**：不做——用户不以说话方式输入（`ui-voice` 已删）。注意与「agent 侧音频识别」区分：agent 理解音频要做，用户说话输入不做。
- **多用户 / 多设备同步、存储迁移**：不做（`docs/plans/host-plan.md:466`）。
- **代码块语法高亮**：不做——代码块纯等宽单色（`--font-mono` 13/20、`--c-text`），不引入彩色 token（见 §16.8）。
- **触屏 / 无 hover 设备适配**：暂不做（2026-09-19 用户定）——所有 hover-only 揭示（顶栏、侧栏 flyout、消息脚注、tooltip）在触屏无路径；窄屏断点只解决宽度、不解决触控。
- **顶栏键盘路径**：不做——`#46 ui-threads` 保持纯 hover（已登记为 §11.10 例外）。
- **全能面板（2026-09-19 定）**：**内容渲染面**——能显示 markdown / 流式 / 图像 / **视频** / 音频 / 文件卡 / 工具卡；**归 `#18 ui-chat`**（消息流本身就是渲染面），**不**另立 UI 容器、**不**承载设置 / 插件管理 / 记忆等页面。原「万能面板」= UI 容器口径作废；「收窄为对话面板」记录也作废。

**残留待办（登记，不展开）**

| 项 | 说明 |
| --- | --- |
| i18n 文案机制 | **文案表已定**：`messages.v1.json` 为全局唯一文案表（错误码 + 全部人话文案，见 ui-shell「文案表」）；**多语言切换策略仍待定**（表内预留 locale 键，切换机制后置） |
| ~~记忆族 UI 入口~~ | **已定**：并入 `#17 ui-settings` **S12 记忆 tab**（浏览 L1/L2/L3、搜索、编辑/删除/置顶、显示来源与 L1 剩余 TTL；写经 #23 计划） |
| ~~会话删除 / 搜索~~ | **已定**：并入 `#16 ui-sidebar`「会话管理」（会话项 `[⋯]` 菜单删除 + 侧栏顶部独立标题搜索框）；删除需 **#11 版本提升**（`session.delete` 软删 + 撤销 toast 走 `session.restore`），见 `plugins/ui-sidebar/DESIGN.md` |
| ~~per-message usage 事件源~~ | **已结清**：#11 消息 def 的 `meta.usage` 即真源，#18 直接读 |
| ~~多模态内容装配~~ | **已定**：并入 `#13` 调配器「按方言格式化」阶段（附件经 #11 资产引用取字节 → 按模型 `modalities.input` 编 content parts；不支持则降级为文本引用） |
| 多模态输出源 | 图像生成 / TTS；**后端能力插件，不需要新 UI**（ui-chat 已有 lightbox / 音频条渲染） |
| 音频识别（agent 侧） | 原生（模型直接吃音频）+ 非原生（独立 STT）两路；与「用户麦克风输入不做」区分 |
| 附件与文档处理 | PDF / docx / 表格文本提取、图片转码、大文件分块（host 分块后置） |
| ~~token 计数与上下文预算~~ | **已定**：并入 `#13` 调配器（v1 估算器；精确 tokenizer 可拆小插件 `token-counter`） |
| ~~模型调用韧性~~ | **已结清**：重试 / 退避 / 限流 / 流断重连归 #12 `model-protocol` v1；端点选择 / 降级链归 #34 `router` |
| 工具结果渲染 | 各工具插件自带渲染器，填 ui-chat 的「工具渲染器挂载点」 |
| 权限规则 | 工具 / 路径 / 命令映射到既有四档（auto / severe / review / deny），不新增档位 |
| 会话导出 / 导入 / 分支 / 自动标题 | **已定**：导出 = v1 客户端由 `chat.history` 生成 JSON / markdown；导入 / 分支 = 后置，需 #11 版本提升（`session.branch` 从某消息分叉）；**自动标题 = 新插件 #49 `session-title`**（首条用户消息 + 用户配置的模型 + ≤10 字，非流式），UI 只显示（见 ui-sidebar / #49） |
| ~~对话面板~~ | **已结清**：并入 `#18 ui-chat`「全能内容渲染面」（markdown / 流式 / 图像 / 视频 / 音频 / 文件卡 / 工具卡），不另立插件 |
| ~~cli 审批交互~~ | 已随 `ui-cli` 撤销而作废（撤销项不占编号；审批交互只在浏览器侧 `ui-approval` #39） |
| S11 / S12 膨胀拆分 | ui-settings 技能页（S11）+ 记忆页（S12）+ 编排页（S13）若继续长大，拆出 `ui-skills` / `ui-memory` / `ui-orchestration` |
| ~~**`workspace` 插件（已入表 #41）**~~ | **已结清**：工作区列表（**进世界**）/ 最近打开（本地 ③）/ 路径校验 / 原生目录选择器 `pick` / `reveal`。详见 `plugins/workspace/DESIGN.md`；执行根由 #27 解析后 bag 传 |

---

## 15. UI 插件化契约（slot 应用 / headless 前端）

### 两档口径（先分类，再套契约）

| 档 | 成员 | slot | 端口 | `/entry.js` | 与宿主 |
| --- | --- | --- | --- | --- | --- |
| **slot 应用** | 16 `ui-sidebar`、17 `ui-settings`、18 `ui-chat`、39 `ui-approval`、40 `ui-composer`、**46 `ui-threads`** | 有 | 有 | 有 | 入站面客户端 + 收事件 |
| **壳本体** | 15 `ui-shell` | 承载全部 slot | 有（唯一主端口） | 有 | 入站面客户端 + 收事件；**不占自身 slot** |
| **headless 前端** | 38 `ui-notify` | 无 | 无 | **有（headless entry，不 mount slot）** | 入站面客户端 + 收事件 |

- headless 前端**不进挂载表**、不占端口、不被 shell 反代（**不 mount 任何 slot**）；但仍有**浏览器侧入口 bundle**（`entry.js`）——由 shell 的**独立 headless 清单**（`state/ui-headless.json` = `[{id, entry}]`，③ 可重算）加载（不进 `state/ui-mounts.json`），用于在浏览器侧调 `Notification` API 等前端能力（宿主侧服务调不了浏览器 API）。加载路径 = shell 提供（**同源静态，不经 `/p/` 反代、不占 slot**）：shell 按清单的 `{id, entry}`（`entry` = 插件包内路径）经**宿主「插件源码读面」**（`host.md` §五 宿主扩展面）取字节并同源服务。
- **能力类口径**：UI 插件统一声明 `ui-<身份名>`（15 `ui-shell` 即 `ui-shell`），仅作占位、互不 `pin`；shell 自身不占 slot（它是壳本体，承载全部 slot 与主端口）。
- **schema 口径**：无世界数据的 UI 插件（15 以外）可**零 schema**（§1.7 模板已放宽为「有世界数据时至少一个」）；`ui-approval` 等不得以 `null` 占位，直接省略 `schema` 字段。
- **UI 插件通用边界（两档共同，四条）**：① **UI 服务不读投影**（`ctx`）；但**入口 term 可投影读**——读 `#1` 槽（判分支）与只读业务投影（如 #17 S13 读 #33/#35/#43、#16/#39 读 #1）是允许的（UI 插件可直接依赖后端插件，见 `docs/plugins.md` §三 第 4 条）；② 不写世界本体——写一律以**客户端身份**连入站面 `put`；③ **无 `pins` 就不能发 `eff`**（要 eff 必须先有 pins 边，见 `docs/plans/draft-design.md` §1.6）；④ **写槽一律 per-thread 键控（H11）**——UI 插件写 `#1` 一律读-改-写 `body.slots`、只覆盖本线程键（`slots[<thread_id>]`，缺省 `_main`），**清槽只清本键、不整值覆盖**（真并发下否则串线程）。

### 布局槽与纵向顺序（本轮定）

右侧 column 自上而下 = `topbar` -> `main` -> `dock` -> `composer`；左列 `sidebar`；`overlay` = 全局覆盖层（17 `ui-settings` 设置模态 / 引导页；**toast 不挂此槽**，归 `#15 ui-shell` 全局 chrome，见 §12 注）。

| slot | 谁 | 行为 |
| --- | --- | --- |
| `topbar` | **46 `ui-threads`** | **线程标签顶栏**：常态 0 高度（不占位），鼠标进入顶部热区才 overlay 展开、离开隐藏；标签 = 线程列表（对话 → 会话标题 / 子代理 / 群聊 / 工作流），点击切当前线程 |
| `sidebar` | 16 `ui-sidebar` | 左列，可展开 / 收缩 |
| `main` | 18 `ui-chat` | 弹性高度，消息流滚动区（按线程 `kind` 分派：对话 / 群聊 / 步骤卡） |
| `dock` | 39 `ui-approval` | **停靠带**：0 高度起步，有待审批项才展开；多条按队列 + 计数 |
| `composer` | 40 `ui-composer` | 底部输入区，自动增高；固定在 column 底部 |
| `overlay` | 17 `ui-settings` | 全局覆盖层：设置模态 / 引导页（居中模态 + 遮罩）。**toast 不挂此槽**——归 `#15 ui-shell` 全局 chrome（见 §12 注） |

- **审批卡片位置**：审批属"继续 / 不继续本回合"的闸门，位置紧贴输入框上方（`dock`），**不遮挡消息流**——用户裁决时能同时看到工具调用上下文。
- 为什么必须拆出 39 / 40：§15 是「一插件一 slot」，卡片要排在输入卡上面，输入卡就必须自己占一个槽；合在 18 里只能覆盖、无法插进 18 的 DOM。

### slot 应用契约（15 / 16 / 17 / 18 / 39 / 40 / 46 共用）

- 每个 UI 插件 = 独立包 / 身份 / 进程 / 端口；有自己的静态资源、自己的入站客户端连接、自己的世代与重启。
- **端口**（③，不进世界）：shell 默认 8787（`CHRONO_UI_PORT`，宿主 `--ui-port` 可覆盖）；子应用默认 `8787 + 序号`，可用 `CHRONO_UI_PORT_<ID>` 覆盖；绑定 127.0.0.1。**唯一对外主端口 = shell 端口**。
- **挂载表**（shell 的本地运行态，③，落地 `state/ui-mounts.json`）：`[{id, path, slot, port}]`，例：`ui-chat -> /p/ui-chat/ -> slot main -> 8788`、`ui-approval -> /p/ui-approval/ -> slot dock -> 8789`、`ui-composer -> /p/ui-composer/ -> slot composer -> 8790`、`ui-threads -> /p/ui-threads/ -> slot topbar -> 8793`；启动无表则自动生成默认值。shell 不认识领域，只按表挂载。
- **一插件一 slot**：挂载表的每个 `id` 只出现一次；同一插件要多占一个 slot 必须拆成两个插件（#39 `ui-approval`、#40 `ui-composer` 就是这么从 #18 拆出来的）。
- **挂载方式**：shell 反代 `/p/<id>/*` 到子应用端口；shell 页面按 slot（`sidebar` / `main` / `dock` / `composer` / `overlay` / **`topbar`**）动态 `import` 子应用入口。
- **子应用入口契约**：`GET /entry.js` 导出 `mount(root, api) -> {unmount()}`；`api = { tokens, theme, navigate, slot, submit, command, cancel, asset, events, toast, uiState }`——除既有 `tokens/theme/navigate/slot` 外，另提供**入站面能力**（`submit` 提交 directive、`command` 按名调命令、**`cancel(run)` 发协议 `cancel{run}` 真取消**、`asset` 资产存取、`events` 订阅宿主事件、**`toast({tone,text,action?})` 请求壳发全局轻提示**、**`uiState` 跨 slot 视图状态读写**），因为 UI 插件（#40 写槽 + 调 `chat.send` + 终止、#16 终止非当前线程 run、#39 调 `approval.decide`、#18 调 `question.answer`、#46 切线程）都需这些能力；各自打包，不共享运行时。
- **`api.uiState`（壳中介视图状态，2026-09-19 定）**：**纯前端视图态**（如 `active_thread`、设置模态开合、引导模式）经壳内存态读写与广播，**不落世界、不占事件通道**；壳定义状态键空间，子应用 `uiState.get(key)` / `uiState.set(key, value)` / `uiState.subscribe(key, cb)`，壳在子应用间广播变更（同源、无 ack）。用途：`#46 ui-threads` 切 `active_thread` → `#18 ui-chat` 按 `conversation` 重拉 `chat.history`；壳判「无配置」→ `#17 ui-settings` 进引导模式。**刷新即丢**（视图态本就不该持久）；需要持久化的视图偏好走 `#2 config` UI 字段。
- **共享 token**：shell 提供 `/assets/tokens.v1.css`；子应用引用该版本化路径，不各自复制。
- **事件**：**浏览器侧 UI 插件经 shell 的 `/events` SSE 桥收宿主事件**（浏览器不能直连宿主本地 socket；shell 持有入站面连接、把宿主广播的 `event` 原样经 `/events` 重播给各子应用——`impl` 作命名空间）；跨 slot 的**世界/状态派生同步**（如 39 审批条 <-> 18 消息流 <-> 40 输入卡）走宿主事件；跨 slot 的**纯视图态同步**（`active_thread` 等）走 `api.uiState`（见上，不占事件通道）。**后端插件不投递事件**（宿主不解释 `topic`，见 `protocol.md` §2.5）。事件来源两类：**插件服务**（`model.delta` = #12、`context.assembled` = #13、`approval.*` = #32、`thread.*` / `workflow.step` / `group.message` = #11、`orchestration.unhealthy` = #44、`question.pending` = #48）与**宿主自身**（`run.started` / `run.finished`，`impl = "host"`，见 `host.md` §五 宿主事件面）。
  - **事件按线程作用域消费（写死）**：run / 流式类事件（`model.delta` / `run.*` / `context.assembled` 等）载荷**必须带 `run` 与 `thread`**；子应用只处理属于当前视图线程的事件。真并发下不按线程过滤，会把后台线程的流 / 用量串进当前视图。
- **失败隔离**：子应用加载失败 -> slot 内错误占位（统一错误码 `ui_unreachable` / `ui_boot_failed` / `ui_version_mismatch` + 重试按钮），不影响其它 slot。

---

## 16. 交互与显示细则（2026-09-19 补，设计语言的一部分）

### 16.1 Tooltip 规范

- **触发**：hover **400ms 意图延时**后出现；移出即收（无退场延时）。**不用 tooltip 承载关键信息或入口**——关键信息必须常驻可见（tooltip 只是补充）。
- **形态**：锚定元素上方 8px；`--c-surface` 底 + 1px `--c-border` + `--radius-sm` + `--shadow-pop`；正文 12px `--c-text`；单行、超长 ellipsis；最长 40 字符，超长说明改常驻文案。
- **可及**：`aria-describedby` 关联触发元素；键盘 focus 同样触发（focus-visible 时显示）。
- **归属**：tooltip 由**各子应用自绘**（用共享 token），壳不提供 tooltip 组件（保持「各自打包、不共享运行时」）。
- **已用点**：侧栏分组（全路径）、目录缺失（原因）、窄屏工具按钮（名称）、上下文用量（明细）、权限档（描述）、附件失败（原因）、图标按钮（名称）。
- **触屏**：无 hover ⇒ tooltip 无路径；因触屏暂不支持（§14），信息可达性以常驻文案为准。

### 16.2 弹层焦点管理（下拉 / 模态 / lightbox）

- **打开**：焦点移入首个可操作项（或弹层容器）。
- **关闭**：`Esc` 关闭并把焦点**归还触发按钮**；点击遮罩关闭；下拉选中后焦点归位。
- **下拉**（模型 / 推理强度 / 权限档）：`role="listbox"` + `↑/↓` 移动 + `Enter` 选中 + 当前项 `aria-selected`。
- **模态**（设置）：焦点陷阱（§11.6），背景 `aria-hidden`；**同屏最多一个模态级遮罩**。
- **lightbox**：`Esc` / 点遮罩关闭，焦点归还缩略图；打开时锁背景滚动。
- 禁止：弹层打开后焦点滞留背景、关闭后焦点丢失。

### 16.3 命中区

- 图标视觉尺寸 16 / 20（§8），**命中区一律 ≥24×24**（密集行内 24×24，工具栏 32×32 含 8px padding）；相邻命中区间距 ≥4px。
- 纯文字按钮命中区含 8px 横向 padding；`<button>` 语义，不用裸 `<div>` 承担点击。

### 16.4 单击 / 双击

- 会话项：**单击 = 立即切换**（幂等，不引入单击延迟）；**双击 = 就地重命名**（第二击在 250ms 内）。双击非当前项时先切换再进入重命名，行为可接受，不额外去抖。
- 其它列表项**不绑定双击**（避免与单击冲突）。

### 16.5 滚动条 / 选区 / 文本选择

- 滚动条用**系统默认**，不自定义皮肤；虚拟化列表滚动条宽度按系统。
- `::selection` = `--c-selection` 底 + `--c-text` 字。
- 消息内容默认可选；**虚拟化窗口化下跨窗选择不支持**（选择范围仅当前窗口，登记限制）。

### 16.6 链接

- 消息 markdown 内链接一律 `target="_blank" rel="noopener noreferrer"`，交**系统默认浏览器**打开；外链不改产品内路由。
- 代码块 / 代码段内文本按纯文本，不自动链接化。

### 16.7 媒体与文件卡显示

- 尺寸上限：图片 ≤ 320×240、视频 ≤ 320×180、音频条 40px 高 × ≤480 宽、文件卡单行 34px；超出进 lightbox / 详情。
- 媒体一律 `loading="lazy"`；音频 / 视频**不自动播放**（需用户点击）；视频不自动循环。
- 媒体加载失败：占位（`--c-bg` 底 + alert-circle） + 「媒体加载失败」+ [重试]。

### 16.8 代码块

- **不做语法高亮**：纯等宽单色（`--font-mono` 13/20、`--c-text`）；底色 `--c-bg`（与 `--c-surface` 分层）、`--radius-md`、水平滚动不换行；行号不做；复制按钮复用 §12 ui-chat 脚注按钮。

### 16.9 日期分隔

- 跨天消息间插入日期分隔：12px `--c-text-3`、居中、上下 `--space-12`；格式 `今天` / `昨天` / `YYYY-MM-DD`（同年省略年、跨年含年）；本地时区。

### 16.10 数字与单位

- token 用量：`k` 小写、≥1000 保留 1 位小数（`1.2k`）、≥1M 用 `M`（`1.5M`）；计数纯数字；计时 `mm:ss`（>1h 用 `h:mm:ss`）；全部 `tabular-nums`（§3）。

### 16.11 层级（z-index）栈（写死）

```
页面内容(0) < 顶栏 overlay(topbar, 10) < 下拉 / tooltip 弹层(20) < dock 停靠带(30)
          < S6 断线横幅(40) < 全局 toast(50) < 设置模态遮罩 + 模态(60) < lightbox(70)
```

- 对应 token：`--z-topbar:10` / `--z-popover:20` / `--z-dock:30` / `--z-banner:40` / `--z-toast:50` / `--z-modal:60` / `--z-lightbox:70`。
- **toast 在模态之上仍可见**（模态打开时的保存反馈）；**同屏最多一个模态级遮罩**；不新增层级值。

### 16.12 焦点环

- 统一 `outline: 2px solid var(--c-text)` offset 2px（§9）；输入类控件用聚焦环（§6），二者**不叠加**（输入类不画 outline，只画聚焦环）。

### 16.13 主题首帧防闪（FOUC）

- 壳在 `<head>` 内联脚本按 `#2 config.ui.theme` + `prefers-color-scheme` **在首帧前**写 `<html data-theme>`，再加载 `tokens.v1.css`；避免浅→深闪。
- config 未就绪时先用系统偏好；就绪后**一次性校正**（不逐帧变、不二次闪烁）。

### 16.14 静态资源降级

- `tokens.v1.css` 失败 → 壳用**内联最小 token 兜底**（至少 `--c-bg` / `--c-surface` / `--c-text` / `--c-border`），并 toast warning；UI 可读不裸奔。
- `icons.v1.svg` 失败 → 图标位留空 + 保留 `aria-label`，不阻塞功能。
- `messages.v1.json` 失败 → 壳回退**内置最小文案表**（错误码原样显示），不阻塞。

---

## 17. 文案与术语规范（2026-09-19 补）

1. **术语表（写死，全 UI 同一概念同一词）**：**会话**（conversation，`#11` 数据）/ **线程**（thread，按 `kind` 分派的视图单元，含子代理 / 群聊 / 工作流）/ **工作区**（workspace）/ **上下文**（组装视图）/ **技能**（skill）/ **记忆**（L1/L2/L3 统称）/ **待办** / **审批** / **编排** / **进化**。禁止同义混用：**不用「对话」指代会话数据**——「对话」仅作默认标签名（`#46` 的默认标签「对话」）。
2. **按钮动词**：动词 + 宾语、2–4 字（发送 / 终止 / 重试 / 批准 / 拒绝 / 撤销 / 添加 / 移除 / 打开 / 保存 / 删除）；破坏性动作直白（删除 / 终止 / 拒绝），**不用泛词「确定 / 取消」**（仅二次确认可用「确认」）。
3. **错误人话**：`错误码 → 人话` 走 `messages.v1.json`；句式「发生了什么 + 可怎么办」；**不用感叹号、不拟人、不道歉**（禁「抱歉」「哎呀」「出错了呢」）；不泄漏密钥；路径显示须脱敏 home（`~`）。
4. **提示语气**：陈述句、现在时、可无主语（「已复制」「已删除 · 撤销」「仍在生成…」）；进行式用「…中」（获取中… / 等待选择… / 读取中…）。
5. **标点**：中文文案用中文全角标点；代码 / 路径 / 错误码 / 命令名保持半角原文；省略号用 `…`（U+2026），**不用 `...`**。
6. **语言**：随系统语言（简 / 繁 / 英），文案表预留 locale 键；切换机制后置（§14）。
7. **禁止**：emoji 作图标或状态（§11.3）；全大写英文长句；口语化 / 营销语 / 感叹式语气。

