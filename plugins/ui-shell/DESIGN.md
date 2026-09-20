# #15 `ui-shell`（壳）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 15 / `ui-shell` |
| 职责 | **浏览器唯一入口**（持主端口 + 入站桥）+ 布局槽（**topbar** / sidebar / main / dock / composer / overlay）+ 路由 + 子应用反代 + 静态与 token / 图标 sprite / **文案表服务** + S0 启动 + S6 断线横幅 + **全局 toast** |
| 依赖 | pins 无；不读投影；`~` 2（`config.read`，判「无配置」）；`<-` 16、17、18、38、39、40、46（挂载 / 加载；46 = `topbar` slot） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["ui-shell"]`，`methods: {"ui-shell":["ping"]}`（占位；UI 插件统一 `ui-<身份名>`，互不 pin） |
| 命令 | 无 |
| schema | `schema/shell.json`（挂载表运行态引用 / 主端口 / 反代前缀）；挂载表落地 `state/ui-mounts.json`（③，启动自动生成默认值） |
| 机制 | 见下「主端口与入站桥 / 挂载表 / 路由 / 子应用契约 / 无配置判据 / 断线与失败」 |
| 边界 | 不做：渲染业务面板 / 业务判定 / 读投影；只做壳（布局 / 路由 / 反代 / token / 入站桥 / 断线横幅 / **toast** / **文案表**） |
| 验收 | 1) 六个 slot（**topbar** / sidebar / main / dock / composer / overlay）可装载与卸载；2) 子应用失败隔离；3) 主题 token 生效；4) 断线横幅正确；5) 挂载表增删不改代码；6) 文案表唯一来源、各插件无硬编码人话文案，且**各身份错误码前缀均已入表**；7) **浏览器与后端入站面（#37）都只经本插件主端口**（无第二个对外端口）；8) **全局 toast 可经 `api.toast` 触发、堆叠 / 时长 / 关闭 / `aria-live` 正确**；9) **`/api/cancel` 发协议 `cancel{run}` 生效**（#40 / #16 可终止指定 run）；10) **`api.uiState` 键空间（`active_thread` / `boot_mode` / `settings_open`）读写与跨 slot 广播正确、刷新即丢、不落世界**；11) **层级栈按 token 生效、toast 在模态上可见、无自造 z-index**；12) **主题首帧无浅→深闪**；13) **三类静态资源任一失败均不阻塞功能** |
| 状态 | 细节设计（2026-09-19）：主端口 + 入站桥 / 挂载表 / 反代 / 子应用契约冻结；错误码统一 `ui_unreachable` / `ui_boot_failed` / `ui_version_mismatch` + slot 占位重试 |

## 主端口与入站桥

- **壳服务 = 产品唯一主端口**（浏览器只连它）；宿主只暴露本地 socket（`socketPath` / `CHRONO_ROOT` 解析，见 `docs/host.md`）。
- **入站桥**：浏览器 HTTP / SSE ↔ 宿主入站帧（`docs/protocol.md`）双向转译——`/api/*` 转 directive / 命令，`/events` 转宿主事件流；明文密钥不经此面（`secrets.put` 直写宿主本地态）。
- 端口 / socket 路径 **永不进世界**；主端口默认 8787（`CHRONO_UI_PORT`，宿主 `--ui-port` 可覆盖）；子应用默认 `8787 + 序号`（`CHRONO_UI_PORT_<ID>` 可覆盖），均绑定 127.0.0.1。

## 挂载表（③，默认启动生成）

```jsonc
// state/ui-mounts.json（可重算；不进世界）：数组形状 [{id, path, slot, port}]（ui-design §15）
[ { "id": "ui-sidebar",  "path": "/p/ui-sidebar/",  "slot": "sidebar",  "port": 8791 },
  { "id": "ui-chat",     "path": "/p/ui-chat/",     "slot": "main",     "port": 8788 },
  { "id": "ui-approval", "path": "/p/ui-approval/", "slot": "dock",     "port": 8789 },
  { "id": "ui-composer", "path": "/p/ui-composer/", "slot": "composer", "port": 8790 },
  { "id": "ui-threads",  "path": "/p/ui-threads/",  "slot": "topbar",   "port": 8793 },
  { "id": "ui-settings", "path": "/p/ui-settings/", "slot": "overlay",  "port": 8792 } ]
// headless（#38 ui-notify）：不进本表；壳按独立 headless 清单加载其 entry.js，不给布局位
```

- **一插件一 slot**（ui-design §15）；增删插件 = 改挂载表，**不改壳代码**（验收 5）。
- `headless` = 不占 slot 但需在浏览器里运行的前端（如 #38 系统通知，要调浏览器 `Notification` API）；壳按**独立 headless 清单**加载其 `entry.js`，**不进 `state/ui-mounts.json`**、不给布局位。清单形状（③，可重算，启动无表则生成默认值）：`state/ui-headless.json` = `[{ "id": "ui-notify", "entry": "execute/entry.js" }]`——`id` 唯一、`entry` 为**插件包内路径**；壳经**宿主「插件源码读面」**（`host.md` §五 宿主扩展面）取字节，并以**壳同源静态路径**（如 `/assets/headless/ui-notify.js`）服务（**不经 `/p/` 反代**，与「不占端口」一致）；只做浏览器侧能力。
- slot 装载：壳取子应用 `entry.js` → `mount(root, api)` → 返回 `{ unmount }`；失败隔离在 slot 内（不影响其它 slot）。
- **后端入站面（#37 MCP）也走本插件主端口**（`/p/<id>/*` 同源反代）：壳不直连插件服务（红线 3），而是转成宿主入站帧 `forward {identity, command, args}` 由宿主转发到目标插件自己声明的入口（**H8 已落地**）。产品对外**只有一个主端口**。

## 路由

```
GET  /                        壳页面（S0 启动 → 各 slot 淡入）
GET  /assets/tokens.v1.css    共享设计 token（唯一来源）
GET  /assets/icons.v1.svg     线性图标 sprite（Lucide 按需子集，唯一来源；ui-design §8）
GET  /assets/messages.v1.json 错误码→人话文案表（唯一来源；各插件按码取文案，禁硬编码）
GET  /favicon.svg             站点图标（字母「C」字标）
GET  /p/<id>/*                子应用反代（含 /entry.js 与子应用 /api、/events）
GET  /events                  壳自己的 SSE（连接态、主题等全局状态）
POST /api/theme               主题切换（写 2）
POST /api/cancel              发协议 cancel{run}（真取消某 run；#40 终止当前回合 / #16 终止非当前线程）
```

- 子应用**同源**反代（无 iframe、无独立端口）：`/p/<id>/*` → 子应用静态 / 接口；`api = { tokens, theme, navigate, slot, submit, command, cancel, asset, events, toast, uiState }`（ui-design §15——`submit` 提交 directive、`command` 按名调命令、`cancel(run)` 真取消、`asset` 资产存取、`events` 订阅宿主事件、`toast` 请求全局轻提示、`uiState` 跨 slot 视图状态读写）。

## 跨 slot 视图状态 `api.uiState`（2026-09-19 定）

- **纯前端视图态**经壳内存态读写与广播：`uiState.get(key)` / `uiState.set(key, value)` / `uiState.subscribe(key, cb)`；**不落世界、不占 `/events` 事件通道、不进挂载表**。
- **状态键空间（壳定义，写死）**：`active_thread`（当前视图线程 id；`#46` 写、`#18` 订阅并按 `conversation` 重拉 `chat.history`）、`boot_mode`（`#17` 引导模式：壳判「无配置」置 `onboarding`，`#17` 订阅进引导）、`settings_open`（`#17` 设置模态开合，供壳/其它 slot 感知遮罩态）。新增键须在此登记。
- **语义**：视图态**刷新即丢**（本就不该持久）；需要持久化的视图偏好走 `#2 config` UI 字段（如 `ui.sidebar_width`），不经 `uiState`。壳只做键值广播，**不认识业务**（不解释 `active_thread` 的会话含义）。

## 无配置判据与断线

- **无配置**：`~ 2 config.read` 返回值无 `vendor` 键 → 壳置 `uiState.boot_mode = 'onboarding'`，`#17 ui-settings` 订阅后进引导模式（壳自身不读投影，判据来自命令返回值；通道见「跨 slot 视图状态」）。
- **S0 启动态**：居中产品名 + 「正在启动…」+ 呼吸条；壳静态部分首帧即画；slot 挂载完成后 150ms 淡入替换。不用骨架屏。
- **S6 断线横幅**：顶部通栏悬浮 warning 条（warning 底 + alert-triangle + 「与宿主断开，重连中…」+ [重试]），overlay 不推挤布局；出现期消息列表加等高 top padding。
- **slot 失败占位**：原地灰色占位卡 = 左 3px danger 竖线 + alert-circle + 「××加载失败」+ 错误码人话 + [重试]；**只做手动重试**，不自动周期重试。

## 全局 toast（2026-09-19 定：归壳）

- **归属**：全局轻提示由壳渲染（与 S6 断线横幅同级的全局 chrome）；**不占 slot**（壳是壳本体、不占自身 slot），不破「一插件一 slot」，也**不再挂 `overlay`**（那是 #17 的槽）。
- **触发两路**：① 子应用经 `api.toast({tone,text,action?})` 请求；② 壳订阅宿主事件按内置规则发（断线 / 重连成功等）。
- **形态**（全局设计语言 §12 注）：右下角堆叠、最多同屏 3 条、超出排队；`--c-surface` + 1px `--c-border` + `--radius-md` + `--shadow-pop`（**不用薄玻璃**）；左 3px 语义竖线（info / success / warning / danger）；100ms 淡入 + 2px 上浮。
- **时长**：info / success 2.5s、warning / danger 4s 自动消失；**带 `action`（如「撤销」）时不自动消失**，须点动作或关闭；hover 暂停计时、右上 x 可关；reduced-motion 静态。
- **语义**：toast 只是瞬时反馈，**不承载裁决**（审批 / 回滚仍在 #39 / #17 S13 做）；`aria-live` 见 ui-design §11.9（info/success = `role="status"`，warning/danger = `role="alert"`）。
- 文案走 `messages.v1.json`，不硬编码。

## 层级 / 主题首帧 / 资源降级（2026-09-19 补，ui-design §16.11–§16.14）

- **层级栈（写死，壳统一）**：页面内容 < 顶栏 overlay < 下拉 / tooltip < dock < S6 横幅 < toast < 设置模态遮罩 + 模态 < lightbox；对应 `--z-topbar:10` / `--z-popover:20` / `--z-dock:30` / `--z-banner:40` / `--z-toast:50` / `--z-modal:60` / `--z-lightbox:70`。**子应用不得自造 z-index**，用 token。**toast 在模态之上仍可见**；同屏最多一个模态级遮罩。
- **主题首帧防闪（FOUC）**：壳在 `<head>` 内联脚本按 `#2 config.ui.theme` + `prefers-color-scheme` **首帧前**写 `<html data-theme>`，再加载 `tokens.v1.css`；config 未就绪先用系统偏好，就绪后**一次性校正**（不逐帧变）。
- **静态资源降级**：`tokens.v1.css` 失败 → 内联最小 token 兜底（`--c-bg` / `--c-surface` / `--c-text` / `--c-border`）+ toast warning；`icons.v1.svg` 失败 → 图标位留空 + 保留 `aria-label`；`messages.v1.json` 失败 → 内置最小文案表（错误码原样）。三者**均不阻塞功能**。
- **tooltip 归属**：tooltip 由**各子应用自绘**（用共享 token，规范见 ui-design §16.1）；壳只提供 token，不提供 tooltip 组件。

## 文案表 `messages.v1.json`（唯一来源，2026-09-19 扩）

- **唯一来源红线**：所有面向用户的人话文案（错误码 → 人话）**只住本表**，由壳服务；各插件按码取文案，**禁硬编码人话**（验收 6）。
- **表结构**：`{ "<code>": { "title": "…", "body": "…", "action": "…"? } }`；预留 `locale` 键供 i18n（切换机制后置，见 ui-design §14）。
- **覆盖要求（本轮扩）**：表不再只覆盖壳的 `ui_*` 三码，**所有插件的对外错误码都必须登记**，码前缀按归属：

  | 前缀 | 归属 |
  | --- | --- |
  | `ui_*` | 本插件（`ui_unreachable` / `ui_boot_failed` / `ui_version_mismatch`） |
  | `model_*` | #12 `model-protocol`（`model_auth_failed` / `model_rate_limited` / `model_bad_request` / `model_server_error` / `model_timeout` / `model_stream_broken` / `model_network_error` / `model_unsupported`） |
  | `discover_*` | #12（`discover_auth_failed` / `discover_bad_url` / `discover_unsupported` / `discover_network`） |
  | `approval_*` | #32 `approval`（队列满 / 拒绝码等） |
  | `sandbox_*` | #25 `sandbox` |
  | `guard_*` | #26 `guard` |
  | `tool_*` | 工具提供者（#28–31 / #37 / #42 / #45 / #47 / #48） |
  | `mcp_*` | #37 `mcp`（`restart_exhausted` / 条目隔离等） |
  | `plugin_*` | #42 `plugin-admin`（`validate` 失败 / 换代隔离等） |

- **登记义务**：各插件在自己的 DESIGN.md 列出本身份错误码；新增码先登记前缀与文案键，再入表。**未登记的码按 `unknown` 兜底文案渲染**（不空白、不报错）。

## 错误码

`ui_unreachable`（宿主不可达）/ `ui_boot_failed`（子应用装载失败）/ `ui_version_mismatch`（子应用与壳契约版本不符）；均取 `messages.v1.json` 人话文案（表覆盖范围见上「文案表」）。

## 跨插件登记

- **#16 / #17 / #18 / #39 / #40 / #46**：挂载方（本插件）；各插件 slot 见挂载表（#46 `ui-threads` = `topbar`，线程顶栏，见 `docs/plans/threads-design.md`）。
- **#38 ui-notify**：`headless` 挂载（不占 slot），由壳加载其子应用以调浏览器 `Notification` API。
- **#37 mcp**：后端入站面经本插件主端口同源反代（`/p/<id>/*`），壳转成 `forward` 帧由宿主转发到目标插件声明的入口（H8 已落地）。
- **#24 secrets**：`secrets.put` 走宿主入站面直写本地文件，不经本插件的 `/api` 世界路径。
- **#2 config**：`/api/theme` 写 `ui.theme`（数据热生效）。
- **各身份（#12 / #25 / #26 / #32 / #37 / #42 / 工具提供者）**：对外错误码按前缀登记进 `messages.v1.json`（见上「文案表」），人话文案唯一来源。
- **#40 ui-composer / #16 ui-sidebar**：终止经 `/api/cancel` → 协议 `cancel{run}`（真取消指定 run）。
- **各 UI 插件**：全局轻提示经 `api.toast` 请求壳渲染（本插件「全局 toast」）；toast **不占 slot、不挂 overlay**。
