# #40 `ui-composer`（输入卡）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 40 / `ui-composer` |
| 职责 | 底部输入区：文本输入 + 附件 + 模型 / 推理强度 / 权限档 + 发送 / 终止 + **输入卡下方上下文用量指示** |
| 依赖 | pins 无；`~` 1（`input.read`，写槽前读当前 `slots` 做读-改-写——#1 侧已登记）（2026-09-20 修订）、`~` 2（`config.read`，取当前模型 / 推理强度 / 权限档）、`~` 14 / 33（`chat.send`）、`~` `model.profile`（按名，归 #17 声明；config 缺档位时拉社区档案；**消费者已在 #17 命令行登记**）（2026-09-20 修订）；写 = 直写 2 与 `input` 槽（载荷先入世界）；**收宿主事件 `run.started` / `run.finished` / `context.assembled`（回合形态与上下文用量，按线程过滤）**（2026-09-20 修订）；**订阅 `api.uiState.active_thread`：发送写 `slots[active_thread]`、提交信封带 `thread=active_thread`（#16 侧注记 run→thread 映射由此闭环）**（2026-09-20 修订）；`<-` 15（挂载 composer）；版本提升：**提出方** —— 要求 #18 把输入卡移出（登记见 #18） |
| 成员 | execute |
| 能力类·方法 | `implements: ["ui-composer"]`，`methods: {"ui-composer":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | 无（发送 = 写槽 + 调 `chat.send` 按名；终止 = 协议 cancel） |
| schema | 无（零 schema 合法：无世界数据） |
| 机制 | 本插件**不持有回合状态**：发送 / 终止导致的形态变化全部订阅宿主事件（`run.started` / `run.finished`）决定；但持有**待发队列（内存，仅本进程）**：回合进行中提交的消息只入队，`run.finished` 后自动取队首写槽 + 调 `chat.send` 续发。输入内容与附件在发送时写入 `input` 槽，避免跨 slot 状态同步；**发送写 `slots[active_thread]`、提交信封带 `thread=active_thread`**（订阅 `api.uiState.active_thread`）（2026-09-20 修订） |
| 边界 | 不做：消息流 / 列表 / 设置 / 判定；不读投影、不写世界本体（写走入站面）、无 pins 不发 eff；不缓存回合状态（状态一律从事件来）；**待发队列不落世界**（刷新即丢，UI 需显示"待发 N 条"） |

## 包契约 `plugin.json`

```jsonc
{ "identity": "ui-composer",
  "implements": ["ui-composer"],                    // 无世界数据 ⇒ 省略 schema 字段（零 schema 合法）
  "methods": { "ui-composer": ["ping"] },           // 占位
  "pins": {},                                       // 发送按名调 chat.send，不建 pins
  "start": "node execute/main.js",
  "protocol": "1",
  "restart": {}, "health": {},
  "state": "recomputable",
  "members": [{ "kind": "execute", "path": "execute/" }],
  "commands": [] }
```

## 附件契约（已定：原生选择器 + 任意格式）

- `[+]` = **原生文件选择器**（`<input type="file" multiple>` / 系统选择器），**任意格式**；粘贴图片 / 拖拽文件同一路径。
- **不需要 #41、也不需要原生插件**：浏览器 `<input type="file">` 会调起 **OS 原生文件对话框**，返回的是 **File 字节**（现代浏览器出于安全**不给绝对路径**）；附件只要字节 ⇒ 直接 `asset.put` 入库。**要绝对路径的只有工作区 `pick` / `reveal`（归 #41，故 #41 用 Rust）**——两者要的东西不同：**附件要字节（浏览器给得了），工作区要路径（浏览器给不了）**。
- 读取 → `asset.put`（宿主资产面）→ `{kind:'asset', sha256, mime, size}`；**世界只存引用**。
- **可解析**（纯文本 / md / 代码 / json / csv…）→ 附件对象带 **`text` 字段**内联文本（供 `#13` 组装为文本片段）；
- **不可解析**（二进制 / 未知格式）→ **只传文件名 + 格式（mime）+ 资产引用**（不猜测、不转码），不带 `text`。
- 文档文本提取（PDF / docx / 表格）归候选「**附件与文档处理**」（v1 只做文本类内联 + 其它仅引用）。
- 发送时：附件引用随文本写入 `input` 槽 `chat.message.attachments`（与 `#1` 同形）；清空规则见下。
- **槽写入 per-thread 键控（H11）**：写 `#1` 一律**先调 `input.read`** → 本地合并本线程键 → `submit` batch（写 `body.slots`、只覆盖本线程键 `slots[active_thread]`，缺省 `_main`），不整值覆盖——见 #1「写入契约」；**跨客户端并发 last-write-wins 为已知限制**（#1 侧登记）（2026-09-20 修订）。

**输入卡**

```
[+] [模型] [推理强度]                      [权限] [发送|终止]
```

- 自动增高；圆角 10；聚焦 = 描边加深一档 + accent 8% 淡色阴影环，150ms 一次性淡入后静止（口径与五态见 `docs/plans/ui-design.md` §6 / §9，2026-09-18 取代旧「灰度描边变化」）。
- 左：`[+]` 附件 / 工具入口（#27 后接）；`[模型]`（锚定弹层，写 2）；`[推理强度]`（**无开关、默认开**；选项先读 `#2 config`，config 缺则调 `model.profile` 拉社区档案并落 config，档案也缺则隐藏按钮；写 2 `params.reasoning`）。**拉取中** = 按钮内等待态（§10，文案「获取中…」），**失败** = 行内 danger 提示 + 可重试，**且不阻塞发送**（发送仍可用当前 config）。
- 右：`[权限]` 四档（`auto` / `severe` / `review` / `deny`，写 2）；`[发送|终止]`。
- Enter 发送、Shift+Enter 换行；IME composition 期间不发送；生成中发送键变「终止」（协议 cancel，宿主丢该 run 计划并 abort 请求）、输入框仍可输入。
- **弹层焦点管理（ui-design §16.2）**：[模型] / [推理强度] / [权限] 三个锚定弹层一律 `role="listbox"` + `↑/↓` 移动 + `Enter` 选中 + `Esc` 关闭并把焦点**归还触发按钮**；当前项 `aria-selected`；点击遮罩关闭。禁止焦点滞留背景。

**视觉细节（2026-09-18 逐插件定案）**

- **工具栏按钮形态**：[模型][推理强度][权限] = 20px linear 图标 + 当前值文字 12px + chevron-down 小箭头的 ghost 按钮（如 `cpu deepseek-chat ∨`），值超长 ellipsis；窄窗口 <480px 只留图标、当前值进 tooltip（§16.1：hover 400ms 意图延时、`aria-describedby`、不承载关键信息）；[+] 仅图标；五态照 ui-design §9；**命中区 ≥32×32（工具栏）/ ≥24×24（行内）**（§16.3）。
- **数据来源红线（禁止硬编码）**：
  - 模型列表**必须**来自用户配置（`2` 的 vendor/model 配置），本插件不内置任何模型名；
  - 推理强度可选项**先读 `#2 config`**（`providers.<vendor>.models.<model>.reasoning`）；config 缺则调 `model.profile`（按名调用，归 #17 声明；**消费者已在 #17 命令行登记**）（2026-09-20 修订）拉社区档案，读到后落 config；**不自建数据集**；
  - 档案也缺档位时**隐藏推理强度按钮**（推理仍默认开启，由 #12 用模型默认档）；不猜、不内置默认表。
  - **三档塌缩（2026-09-20 修订）**：`reasoning_map` 值全同（如 dashscope / zai 三档同布尔）时**折叠档位控件为单开关**（防假档位；vendor 侧已注记）。
- **权限档按钮**：四档 = `auto`（全过）/ `severe`（工作区读写；工作区外 / 危险操作**弹卡**）/ `review`（**工作区只读**）/ `deny`（全拒）；**全局**（写 `#2 config.permission`），由 `#25 sandbox` 强制、`#26` 判升级。图标+文字统一 `--c-text`（浅黑），**不随档位变色**；点击弹筛选式列表弹层（四档单行单选、当前档 check + selection 底，每档描述文案明确实际能力：如 review「只读工作区」、deny「全部拒绝」）；弹层出入照 §9 白名单。
- **发送/终止键**：accent 实底、尺寸恒定；生成中图标 arrow-up→square 交叉淡化 100ms 后，square 图标做**小幅呼吸**（呼吸动画族，见 ui-design §10；reduced-motion 静态）作为「生成中」浅动态；**禁止红色等一切深色鲜艳色**（低饱和纪律，见 ui-design §11）。
- **待发 chip**：输入卡右上角外挂 12px ghost chip「待发 N」（`--c-text-2` 字 + selection 底 + `--radius-sm`），hover 升一级；点击弹锚定小弹层列队内消息摘要、每条 x 可移除（队列在内存、刷新即丢，需给反悔通道）；数字变化交叉淡化 100ms；空队列不渲染。
- **输入区**：min-height 单行 40、自动增高（已锁）；placeholder「输入消息…（Enter 发送）」14px `--c-text-3`。
- **上下文用量行（2026-09-19 补，用户要「输入框下面加个轻量上下文占多少」）**：输入卡下方一行 12px `--c-text-3`，形如 `上下文 42k / 128k`（`tabular-nums`）；数据源 = **宿主事件 `context.assembled`**（#13 每次组装产，载荷含 `used` / `budget` / `sources` / `trimmed`，**按 `thread` 过滤取当前线程最近一次**），**无事件（尚未组装过）时不渲染该行**（不占高度）。
  - **色彩**：<75% 用 `--c-text-3`；≥75% 用 warning 前景字（与 #13 的 75% 压缩提示同阈值）；≥100%（`budget_exceeded`）用 danger 前景字 + 文案「上下文已满」。
  - **hover tooltip**：明细（系统提示 / 工具 / 记忆 / 历史 / 技能各占 token + 被裁剪项及原因），走 §9 锚定弹层；点击无动作（只读）。
  - **不在本行做压缩操作**：压缩由 agent 经记忆工具触发（#13 / #19），本行只呈现、不挂按钮。
  - 文案走 `messages.v1.json`；`aria-live="polite"`、`aria-atomic="true"`（ui-design §11.9）。
- **附件区（2026-09-18 补，原「#27 后接」的视觉空白）**：已选附件以 chip 行渲染在文本行上方，**仅有附件时占位**——图片 chip = 40×40 缩略图（`--radius-sm` + 1px `--c-border`）+ 右上角 16px x 移除钮（hover 淡入）；文件 chip = paperclip 16px + 文件名 12px ellipsis（≤160px）+ x；横向排列、超出换行；>4 个折叠为「+N」chip，点击展开。粘贴图片 / 拖拽文件到输入卡 = 同一 chip 行（拖拽悬停时输入卡描边 `--c-text-3`，复用聚焦描边语言、不新增色）。
- **附件等待态**：chip 上覆 40% 遮罩 + 16px 呼吸环（§10 呼吸族）；成功恢复；失败 = chip 1px danger 描边 + hover tooltip 原因 + 点击重试。
- **附件清空规则**：发送成功随输入清空；附件读取失败则 chip 保留并标注（不静默丢）。
- **窄屏（2026-09-19 补）**：≥768 全工具栏；<768 保持全工具栏、<480 仅图标（已定）；断点总表见 ui-design §4，输入卡左右边距随断点取 `--space-12` / `--space-16`。**终止键**（生成中）经 `api.cancel(run)` 发协议 `cancel{run}`（与 #16 终止非当前线程同路）。**`run` 来源（2026-09-20 修订）**：从 `run.started`（匹配 `active_thread`）缓存当前线程 run，`run.finished` 清空。

| 字段 | 内容 |
| --- | --- |
| 验收 | 1) 发送 -> 流式 -> 定稿全通；2) 终止可用（经 `api.cancel` 真取消）；3) 模型 / 推理强度 / 权限档即时生效且可回放；4) 换 14 / 33 实现零改动；5) 崩溃不影响消息流（18）与审批条（39）；6) 回合中连发 N 条 -> 依次排队并自动续发，UI 显示待发数，刷新后队列清空；7) **上下文用量行按 `context.assembled` 正确显示、按线程过滤、无事件时不渲染**；8) **三个下拉可键盘操作、`Esc` 关闭且焦点归位；档案拉取中不阻塞发送、失败可重试；命中区 ≥24×24** |
| 状态 | 已定（本轮从 #18 拆出）：拆的理由是审批卡片要精确落在输入框上方，而 `docs/plans/ui-design.md` §15 是「一插件一 slot」—— 输入卡必须自己占一个槽，卡片才有可能排在它上面 |

> 位置关系：右侧 column 纵向 = `main`（18 消息流）/ `dock`（39 审批条）/ `composer`（本插件），见 `docs/plans/ui-design.md` §15。
>
> **slot / 端口（③）**：slot = `composer`；子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），绑定 127.0.0.1，具体值由 `#15` 挂载表定；本插件不自开对外端口。
>
> **写入口径（2026-09-19 收口）**：本插件与 #17 `ui-settings`、#15、#16 都会写同一份 `#2 config`。框架无字段级 CAS，写是整值 `put` + `add_gen`；并发写者一律走「读-改-写 + 有界重试（3 次）」，不静默丢字段——详见 `plugins/config/DESIGN.md`「并发语义」。
