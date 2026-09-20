# #39 `ui-approval`（审批卡片）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 39 / `ui-approval` |
| 职责 | `dock` 槽的审批停靠带：展示待审批队列（计数 / 整批裁决）+ 提交裁决（批准 / 拒绝） |
| 依赖 | `->` 32（pins：`approval.list` / `approval.decide` 的入口 term 发 eff）；`+` 1（入口 term 读 `approval.decide` 槽）；`<-` 15（挂载 dock）；事件与 32 约定 |
| 成员 | execute, terms |
| 能力类·方法 | `implements: ["ui-approval"]`，`methods: {"ui-approval":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | `approval.list`、`approval.decide`、`approval.decide_all`（无参；读 `input` 槽 kind 后 eff 到 32） |
| schema | 无（零 schema 合法：无世界数据；槽形状借 `#1` 的 `approval.decide`） |
| 机制 | 卡片态由宿主事件（`approval.pending`，来自 32）驱动；**item 带 `thread`（#32 侧已加）——写 `slots[item.thread]`；无 thread 项落 `_main`**（2026-09-20 修订）；单条裁决 -> 写 `input` 槽 `{kind:"approval.decide", id, verdict}` + 调 `approval.decide`；整批裁决 -> 写 `{kind:"approval.decide", verdict}`（缺 `id` = 全部）+ 调 `approval.decide_all` -> 入口 term eff 到 32 -> 32 回写并**发 `approval.decided` 终局事件**（补登记，卡片条目据此淡出——#32 侧已定义，2026-09-20 修订），使 18 的消息流继续。**verdict 值 = `accept` / `deny`**（槽词汇，见 #32「verdict 词汇映射」）；item 状态读 `approved` / `denied`。**槽写入一律 per-thread 键控**（H11）：读-改-写 `body.slots`、只覆盖本线程键（缺省 `_main`），见 #1「写入契约」 |
| 边界 | 不做判定（裁决语义归 32 / 26）/ 不做审批流程本体 / 不做对话视图；**服务不读投影、不写世界**（入口 term 读 `input` 槽判分支）；无 pins 不发 eff |
| 验收 | 1) 待审批事件到达即出停靠条；2) 裁决后 32 收到且消息流继续；3) 崩溃不影响 main / composer；4) 多项队列计数与「全部批准」正确；5) 换 32 实现零改动；6) **三种 `kind` 各出对应模板**，编排变更显影子指标且两类结构变更默认展开；7) **等待计时正确（>2min warning）、`expired` 弱化但仍可裁决、[全部拒绝] 明确为放弃并终止本回合**；8) **[全部批准] 与 [全部拒绝] 均走原地 3s 二次确认**；9) **裁决全键盘可达、失败行内收口且条目不消失、层级用 `--z-dock`** |
| 状态 | 细节设计（2026-09-19）：卡片=**摘要 + 可展开全量**；停靠带 / 队列 / 整批裁决冻结。**版本提升**：按 `#32` item 的 `kind` 分三种模板（工具调用 / 编排变更 / 插件写），提出方登记见 `plugins/loop-policy/DESIGN.md` |

## 包契约 `plugin.json`

```jsonc
{ "identity": "ui-approval",
  "implements": ["ui-approval"],                    // 无世界数据 ⇒ 省略 schema 字段（零 schema 合法）
  "methods": { "ui-approval": ["ping"] },           // 占位
  "pins": { "approval": "approval" },               // eff port -> #32 身份
  "start": "node execute/main.js",
  "protocol": "1",
  "restart": {}, "health": {},
  "state": "recomputable",
  "members": [
    { "kind": "execute", "path": "execute/" },
    { "kind": "term",    "path": "terms/" }
  ],
  "commands": [
    { "name": "approval.list",       "entry": "terms/approval.list.json" },
    { "name": "approval.decide",     "entry": "terms/approval.decide.json" },
    { "name": "approval.decide_all", "entry": "terms/approval.decide_all.json" }
  ] }
```

- 命令无参：入口 term 读 `input` 槽 kind 后 eff 到 `#32`；**写类载荷先入世界**（裁决经槽 `{kind:'approval.decide', id?, verdict}`，缺 `id` = 整批）。**裁决命令（`approval.decide` / `decide_all`）的入口 term 产 `[eval(command:'chat.resume', args 含裁决), write(记裁决 + 清槽)]` 续跑计划（H18；与 #32 / #14 侧一致）**（2026-09-20 修订）。
- **卡片信息量（已定）**：默认显 tier + 工具名 + 参数**摘要**；点击条目**就地展开全量**（mono、可选中复制）；`severe` 档条目默认展开。

```
dock 槽（M2 薄玻璃停靠带，紧贴输入卡上方；不推挤消息流，出现 / 消失 200ms）
[ 待审批 2 ] tool-shell 请求执行 rm -rf …        [ 全部拒绝 ] [ 全部批准 ]
  ├ 条目 1 命令 / 参数摘要（只读）      [ 拒绝 ] [ 批准 ]
  └ 条目 2 …                            [ 拒绝 ] [ 批准 ]
```

- 无待审批项时**不占高度、不渲染**；多项按队列展示 + 计数（见 #32 多项队列）。

## 三种卡片模板（按 `item.kind` 选，本轮新增）

`#32` 的 item 带 `kind`，本插件按它选模板；**本插件不做判定**，只渲染。

| `kind` | 摘要行 | 展开内容 |
| --- | --- | --- |
| `tool_call` | 工具名 + 命令/参数摘要（原有） | 完整命令 / 参数（mono、可复制） |
| **`orchestration_change`** | `编排变更：+2 节点 / -1 边` + **影子指标增减**（如 `token +12% · 步数 +1`） | 图 diff 全量 + 影子回放指标对照表 |
| **`plugin_write`** | `插件写入：tool-fs（3 个文件）` + `validate ✓` | 变更文件清单 + `validate` 结果 + **换代失败即隔离**的红色提示 |

**编排变更卡片（`orchestration_change`）**：

```
dock 槽
[ 待审批 1 ] 编排变更：agent.step → composite（+3 节点）   [ 拒绝 ] [ 批准 ]
  ├ 影子回放（历史 12 回合，零模型调用）
  │   token   142k → 159k  (+12%)      步数    3.2 → 4.1
  │   工具失败 8% → 6%                  审批触发 2% → 2%
  └ 图 diff（点击展开全量）
```

- **影子指标只呈现、不否决**（`#32` 既定口径）：用户明确要的变更不该由系统替他拒，
  但必须让他看见代价。指标增减用 `--c-text-2`，**恶化项**用 warning 前景字、**改善项**用 success 前景字，
  不加图标、不加百分比条（避免暗示系统在替他判断）。
- 图 diff 摘要格式固定为 `±N 节点 / ±M 边`；展开显逐项（加了哪个契约、删了哪条边、改了哪个 `links`）。
- `plugin_write` 无影子指标（换的是进程、跑不了影子回放），改显 `validate` 结果与**隔离风险提示**——
  这处不对称是刻意的，卡片上要写明"失败将隔离该插件分支，需回滚上一世代"。
- **两类结构变更默认展开**（与 `severe` 档条目同规）：它们改的是系统自身行为，不该折叠。

## 等待、超时与退出路径（2026-09-19 补）

- **等待计时（进度文案，红线 §10「禁止静默无限等待」）**：停靠带头部「待审批 N」右侧追加 12px `--c-text-3` 计时「已等待 mm:ss」（`tabular-nums`，自 `approval.pending.at` 起算，按秒更新）；**>2min 转 warning 前景字**。
- **退出路径（写死）**：dock 头部 [全部拒绝] 即**放弃并终止本回合**——裁决 `deny` 后 #33 终止、不再触发续跑（#32 既定）。故文案明确为「全部拒绝 = 放弃本回合」，避免被误读成「只拒掉一条工具调用」。**与 [全部批准] 对称，走原地 3s 二次确认**（按钮就地变「确认拒绝并终止本回合？」，再点执行，超时、点他处或 `Esc` 回退）；**不新增第三个按钮**（保持既有冻结的头部行）。**单条 [拒绝] 也终止本回合**（#33 `deny → refusal` 收口）——按钮文案与确认提示写明「拒绝并终止本回合」（与 [全部拒绝] 同语义）（2026-09-20 修订）。
- **`expired` 状态呈现**：#32 超时只标 `expired`、**不自动裁决**（安全）。本插件对 `expired` 项：整条降为 `--c-text-3` + 追加 12px「已超时」标签（warning 前景字），**仍可裁决**（[批准] / [拒绝] 保持可用），计数仍计入「待审批 N」。**不自动消失、不自动拒绝**——诚实反馈（§11.7）。
- **不静默消失**：任何 `pending` / `expired` 项在裁决前都留在停靠带；停靠带 0 高度只在无任何项时成立。
- **无「自动重试」**：超时后是否继续等由 #33 决定；本插件只呈现状态与提供裁决，不代系统判断。
- 计时与状态文案走 `messages.v1.json`；`aria-live="assertive"` 播报计数与「已超时」（ui-design §11.9）。

## 跨插件登记（补）

- **#32 approval**：item 新增 `kind` / `shadow` 字段；本插件按 `kind` 选模板。
  裁决路径不变（写 `#1` 槽 + `approval.decide`）。**补登记 `approval.decided` 终局事件——卡片条目据此淡出（#32 侧已定义该终局事件）**（2026-09-20 修订）。
- **#33 loop-policy**：编排变更的 diff 与影子指标由其产出、经 `#32` item 的 `shadow` 引用传入；
  本插件**不读 #33 投影**（保持无 pins、只 pin `#32`）。
- **#38 ui-notify**：`approval.pending` 事件带 `kind`，通知文案分流（编排变更 / 插件写 / 工具调用）。

**视觉细节（2026-09-18 逐插件定案）**

- **停靠带质感（复核保留「薄玻璃」）**：`backdrop-filter: blur(12px)` + `--c-glass` 底色（透明度 ≥80% 保 AA）+ 1px `--c-border` + `--shadow-pop`；不支持 backdrop-filter 的环境自动降级实色 `--c-surface`；薄玻璃为全局唯一例外（见 ui-design §6）。带体最大高 40vh，超出内滚。
- **头部行**：左「待审批 N」计数（12px `--c-text-2`，数字变化交叉淡化 100ms，图标 list 16px）；右 [全部拒绝]（ghost + danger 低饱和前景字）与 [全部批准]（accent 实底小按钮）。
- **头部二次确认（2026-09-19 补）**：[全部批准] 与 [全部拒绝] **对称**——点击 → 按钮就地变「确认批准 N 项？」/「确认拒绝并终止本回合？」保持 3s，再点执行，**超时、点他处或 `Esc` 回退**（Esc 回退 2026-09-20 补，与 ui-design §16.2 弹层习惯一致；焦点始终留在按钮上）；不做弹窗/遮罩。
- **条目行**：工具名 12px `--c-text-2`（如 tool-shell）+ 命令摘要 `--font-mono` 12px 单行 ellipsis；**点击条目就地展开**完整命令/参数（mono 13/20、可选中复制，高度 150ms 过渡），再点收起；**severe 档条目默认展开**。
- **条目按钮**：[拒绝] ghost + danger 前景字；[批准] accent 实底小按钮 28px 高、`--radius-sm`。
- **语义竖线**：每条左 3px warning 前景色竖线（与内联错误条 danger 竖线同语言、不同语义色）；批准/拒绝结果不回放动画，条目按 §10 淡出移除。
- **按钮等待态**：裁决提交后条目按钮进入按钮内等待态（§10），32 回执前不可重复点击；**失败** → 该条行内 danger 文字（人话，走 `messages.v1.json`）+ [重试]，条目仍留停靠带（不静默消失）。
- **键盘与命中区（ui-design §16）**：条目展开、[批准] / [拒绝] / [全部批准] / [全部拒绝] 全部 Tab 可达、`Enter` / `Space` 触发、`focus-visible` 焦点环；条目按钮命中区 ≥24×24、头部按钮 ≥28 高；**不做快捷键**（ui-design §14）。
- **层级**：停靠带用 `--z-dock`（在弹层之上、S6 横幅 / toast 之下，ui-design §16.11）。

- **slot / 端口（③）**：slot = `dock`；子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），绑定 127.0.0.1，具体值由 `#15` 挂载表定；本插件不自开对外端口。
- 共用契约见`docs/plans/ui-design.md` §15「slot 应用契约」；全局 UI 设计语言见 `docs/plans/ui-design.md`。
