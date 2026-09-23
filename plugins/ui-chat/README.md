# ui-chat（全能内容渲染面 · 对话页消息流）

对话页的**全能内容渲染面**：markdown / 流式 / 图像 / 视频 / 音频 / 文件卡 / 工具卡 /
question 交互卡，以及按线程 `kind` 分派的群聊与工作流步骤卡。本插件是独立包 / 独立进程 /
独立端口，自带浏览器静态资源、自己的入站客户端连接；事件经壳 `/events` 总线（`api.events`）订阅。

- 能力类：`ui-chat`（`ping` 占位，UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；命令 / 提交一律按名经入站面。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`，宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / socket / markdown / 消毒 / 窗口化 / lightbox 全自实现。

## 渲染源与数据获取路径

**渲染源 = `session` 插件的全量消息（展示真源）**，与上下文组装视图无关：

1. 浏览器调本插件 `POST /api/command`，body `{name:"chat.history", args:{conversation?}, thread?}`；
2. 本插件服务经**自己的入站连接**发 `command` 帧（按名调用，不需 pins）；
3. 宿主返回投影值 `{body, refs}`；入口 term 返回的 `value` 即会话 body + 引用闭包；
4. 浏览器沿 `prev` 从 `head` 逆序还原、反转成展示序（`execute/web/history-model.js`）；
5. `chat.history` 命令不可用时 → 行内错误占位（`unknown_command` 人话），不崩。

## 子应用入口契约

```
GET /entry.js   → ES module，导出 mount(root, api) -> {unmount()}；另导出 contract = "1"
GET /<name>.js  → 浏览器视图层模块（扁平白名单名，源码 ESM 直接服务，不自打包）
POST /api/command          → 入站 command（chat.history / input.read / question.answer / chat.send…）
POST /api/submit           → 入站 submit（directive(s) + thread）
POST /api/question/answer  → 读-改-写 input 槽 + 按名调 question.answer（写走入站面）
GET  /api/asset?sha256=…   → 入站 asset.get，直接回原始字节（媒体元素 src 用）
```

- 浏览器侧 `api` 由壳提供；本插件只借用 `api.uiState`（`active_thread` 线程切换），
  其余命令 / 提交 / 资产走**本插件自己的入站连接**（失败隔离：本 slot 内错误占位 + 重试）。
- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v2.svg`（图标）、
  `/assets/messages.v1.json`（错误码人话）；零硬编码色值。

## 渲染器清单

| 位置 | 渲染器 | 说明 |
| --- | --- | --- |
| 内容 parts | `text` | 自实现 markdown + 白名单消毒（禁 script / 事件属性 / 危险 URL） |
| | `image` / `video` / `audio` / `file` | 尺寸上限按全局 UI 设计语言；`loading="lazy"`；音视频不自动播放；点击进 lightbox / 播放器 |
| 工具卡 | `form:"line"` | 一行（label + summary），不可展开 |
| | `form:"card"` | 折叠（label + summary）→ 展开（detail） |
| | `tone` | `ghost` / `plain` / `solid` 质感 |
| | `live:true` | 收 `tool.start` 开卡、按 `call_id` 追加 `tool.delta`、`tool.end` 收尾，回合末以消息 part 定稿 |
| | 降级 | 无 `render` / 未知 form / 未知 kind → markdown 文本降级 |
| detail.kind | `text` / `code` / `diff` / `matches` / `paths` / `list` / `table` / `json` / `file` / `image` / `terminal` / `question` | `diff` 新增绿 / 删除红 / 修改黄 + 上下文折叠；`terminal` stdout / stderr 分色 + 退出码；`question` 交互卡 |
| 线程视图 | `main` / `subagent` | 普通消息流（子代理顶部人格头） |
| | `group` | 首字母圆标 + 名、连续发言人只首条显名、当前发言者呼吸环、未读锚点 |
| | `workflow` | 步骤卡：当前步骤 + 第 i/N 步 + 状态三重编码 + 1px 进度条；展开只读节点列表；失败节点拒绝码 + 重试 |

## 事件过滤口径

- 浏览器经壳 `api.events` 订阅宿主事件（`impl` / `topic` 不改名），不再经本端口 SSE。
- 浏览器按 **`payload.thread === 当前视图线程`** 过滤（写死，`history-model.js#matchesThread`）：
  - 有 `active_thread` 时严格相等；
  - 无 `active_thread` 时视图线程视为主线程，接受 `null` 与 `_main`。
- 处理的事件：`model.delta`（流式追加）、`tool.start/delta/end`（live 工具卡）、
  `run.started/run.finished`（呼吸条 → 定稿重拉 `chat.history`；`cancelled` 保留已生成部分 + 「已取消」）、
  `group.message`（未读锚点）、`workflow.step`（步骤卡）、`thread.*`（重拉）。
- **run 生命周期按 run id 关联，不把任意 run 当作自己的回合**：`run.started` 仅在匹配当前视图线程时起流；
  `run.finished` 仅当事件 `run` 与本轮在途流一致时收束并重拉 `chat.history`，其余 run 的终局一律忽略
  （否则任意 run 都会反复触发重拉）。`origin === 'periodic'` 的周期 run 不是对话回合，其 `run.started` 不建流。

## 运行

```sh
npm test                          # 纯函数视图层 + 服务协议测试（node --test）
node tools/e2e-smoke.mjs          # 宿主装配 + HTTP E2E（pack/seed → start → HTTP → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/`（含 `execute/web/`））随源码入世。本插件无世界数据、零 schema，故无 `schema/` 目录。
