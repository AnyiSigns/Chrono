# ui-chat（全能内容渲染面 · 对话页消息流）

对话页的**全能内容渲染面**：markdown / 流式 / 图像 / 视频 / 音频 / 文件卡 / 工具卡 /
question 交互卡，以及按线程 `kind` 分派的群聊与工作流步骤卡。本插件是独立包 / 独立进程，
**不再自持端口与 HTTP 面**：浏览器侧客户端半边是一段注册进壳 `main` slot 的模块，
事件与命令经壳 api（`ctx.events` / `ctx.command` / `ctx.submit`）走宿主。

- 能力类：`ui-chat`（`ping` 占位 + `client.read` 只读交付，UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；命令 / 提交一律按名经宿主命令面。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`，宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：markdown / 消毒 / 窗口化 / lightbox 全自实现；`esbuild` 仅构建期 devDependency。

## 客户端半边契约

客户端半边源码为 `execute/web/entry.tsx`，导出 `contract = '2'` 与 `register(ctx)`，
把 `App` 注册进 `main` slot（见 `docs/ui-client-half.md` 与 `types/ui-contract.d.ts`）：

```tsx
export const contract = '2'
export function register(ctx: SlotContext): void {
  ctx.slots.register({ name: 'main' }, App)
}
```

- 业务状态住 React-free store（`execute/web/thread-store.ts`：`getSnapshot` / `subscribe` /
  `commit`），壳侧经 `ctx.useStore` 以 `useSyncExternalStore` 绑定；组件只渲染，不各自持业务态。
- 叶子纯模块（markdown / markdown-cache / sanitize / detail-renderers / tool-card /
  render-parts / history-model / thread-store / group / workflow / windowing / media /
  date-sep / usage / copy / messages / lightbox）保持零 `react` import，组件吃其产出的
  视图模型，不就地拼字符串。
- markdown 正文统一经 `Markdown` 组件（`renderMarkdownIncremental` + 白名单消毒 +
  `dangerouslySetInnerHTML`，全仓唯一允许处）；流式与定稿共用该组件。增量缓存按「不在
  围栏内的空白行」切块，已完成前缀只解析 + 消毒一次，只有尾部未完成块随每帧重解析。

## 渲染源与数据获取路径

**渲染源 = `session` 插件的全量消息（展示真源）**，与上下文组装视图无关：

1. 浏览器经壳 `ctx.command('chat.history', {conversation?}, {thread})` 调用宿主命令面；
2. 宿主按名路由到命令声明方，返回投影值 `{body, refs}`；
3. 浏览器沿 `prev` 从 `head` 逆序还原、反转成展示序（`execute/web/history-model.ts`）；
4. `chat.history` 命令不可用时 → 行内错误占位（`unknown_command` 人话），不崩。

## 渲染管线（快照 + 有序增量 + 定稿替换）

每线程一份视图，真源是 React-free store（`execute/web/thread-store.ts`）。渲染器只读 store；
流式与定稿共用同一条 markdown 管线——在途回合就是消息列表末尾的一条 assistant 条目。

- **快照**：`chat.history` 落地即替换权威消息段（会话 / refs / 消息 / kind）。历史请求带
  单调序号，只认最新一次回包，线程切换 / 并发重拉不会用旧线程数据覆盖新视图。
- **有序增量**：`model.delta` 只追加到在途回合。在途回合持**到达序渲染段**（`segments`：
  reasoning / text / tool），渲染器按段序交错展示——工具卡不会被挤到正文之后。同一帧内到达的
  增量合帧为一次 store 提交；任何非增量事件到达前先冲刷在途增量，保证「同连接内按到达顺序 fold」
  不被合帧打乱。
- **定稿替换**：`run.finished`（done）把在途回合标记为定稿中，随后一次快照在同一帧内原地收口；
  `cancelled` 保留已生成部分 + 「已取消」。定稿后的工具卡与推理块来自 assistant 消息的展示
  `parts`（由 `turn.commit` 落盘），故刷新 / 切线程后仍可见。
- **乐观用户消息**：回合进行中从 `chat.message` 槽读出在途用户消息并即时渲染；权威快照落地
  即收起，避免与历史重复。用户消息不再等到回合结束才可见。
- **错误边界**：每条消息（含流式回合、群聊气泡）各自包一层渲染异常边界，单条渲染异常降级为
  行内提示，不冒泡崩掉整棵聊天树。

客户端事件语义（`thread-store.ts` 头部与单测逐条锁住）：

1. 单连接有序：同一 SSE 连接内事件按到达顺序 fold，不重排。
2. run 生命周期单调：`run.started` 建立 / 替换在途回合；`model.delta` / `tool.*` 只作用于 run 匹配的在途回合。
3. 迟到帧丢弃：已定稿 run 的后续 delta / tool 帧丢弃，防定稿后冒出幽灵回合。
4. 缺 started 自愈：首个 delta / tool.start 到达即建在途回合，started 丢失不丢流。
5. 无关终局忽略：`run.finished` 无匹配在途回合即判为无关 run（写 run / 周期 run），不触发重拉。
6. reset 语义：`model.delta.reset === true` 清空在途正文与推理段再追加（流重试重放，不重复追加）。
7. 快照权威：快照替换权威段；在途回合只在定稿 / 取消 / 线程切换 / 重连时清除。
8. 重连重同步：连接 false→true 且确曾断线时丢弃在途回合并强制快照重同步。

## 构建与产物交付

- `plugin.json.build` 声明两步：`npm ci`（按 `package-lock.json` 恢复 devDependency）与
  `node execute/build.mjs`（脚本内调 esbuild JS API，避开 build args 白名单「不含 =」与
  esbuild CLI 字符串选项必须 `--opt=value` 的冲突），产物落 `execute/web/dist/entry.js`。
- 产物 `externalize` 壳 vendor（`react` / `react/jsx-runtime` / `react-dom` /
  `react-dom/client` / `use-sync-external-store` 及其 shim），单文件输出、不做 code splitting。
- `.worldignore` 排除 `execute/web/dist/`：产物世代内可重算，入世会污染内容哈希。
- 产物被 `.worldignore` 排除，`host.source.read` 读不到，故由插件自己的只读命令交付：
  `ui-chat.client.read`（`terms/client.read.json` eff 到同名方法），参数 `{path}`，
  返回 `{path, text}`；只接受包内相对 `.js` 路径，拒绝绝对路径 / 盘符 / 反斜杠 / `..` / 空段
  （`execute/client-read.ts`）。壳 `uiSource` 取字节后以 `/assets/ui/ui-chat.js` 同源服务。

## 渲染器清单

| 位置 | 渲染器 | 说明 |
| --- | --- | --- |
| 内容 parts | `text` | 自实现 markdown + 白名单消毒（禁 script / 事件属性 / 危险 URL） |
| | `reasoning` | 推理折叠块：默认收起，头部「推理」标签（流式中带呼吸点），展开为内嵌灰底 markdown；只作展示，不进模型上下文 |
| | `image` / `video` / `audio` / `file` | 尺寸上限按全局 UI 设计语言；`loading="lazy"`；音视频不自动播放；点击进 lightbox / 播放器。资产经 `ctx.asset.get` 取字节转 blob URL（可 revoke，替代 data URL）；图片解码前探测自然尺寸并预留精确占位盒，消除懒加载跳动 |
| 工具卡 | `form:"line"` | 一行（图标 + label + summary），不可展开 |
| | `form:"card"` | 折叠（图标 + label + summary + 状态角标）→ 展开（detail）；在途卡展开体只给流式输出（`live:true`）或调用参数，定稿卡展开体渲染描述符与结果合并后的 detail |
| | `tone` | `ghost` / `plain` / `solid` 质感（line 形态仅 `solid` 留左侧强调条） |
| | 状态角标 | 运行中呼吸点 / 成功勾 / 失败叹号（`tool.end` 的 `ok` 与定稿 `status` 驱动） |
| | `live:true` | 收 `tool.start` 开卡、按 `call_id` 追加 `tool.delta`、`tool.end` 收尾，回合末以消息 part 定稿 |
| | 降级 | 无 `render` / 未知 form / 未知 kind → markdown 文本降级 |
| detail.kind | `text` / `code` / `diff` / `matches` / `paths` / `list` / `table` / `json` / `file` / `image` / `terminal` / `question` | `diff` 新增绿 / 删除红 / 修改黄 + 上下文折叠；`terminal` stdout / stderr 分色 + 退出码；`question` 交互卡 |
| 线程视图 | `main` / `subagent` | 普通消息流（子代理顶部人格头） |
| | `group` | 首字母圆标 + 名、连续发言人只首条显名、当前发言者呼吸环、未读锚点 |
| | `workflow` | 步骤卡：当前步骤 + 第 i/N 步 + 状态三重编码 + 1px 进度条；展开只读节点列表；失败节点拒绝码 + 重试 |

## 事件过滤口径

- 浏览器经壳 `ctx.events.onAny` 订阅宿主事件（`impl` / `topic` 不改名），不再有本插件端口 SSE。
- 浏览器按 **`payload.thread === 当前视图线程`** 过滤（写死，`history-model.ts#matchesThread`）：
  - 有 `active_thread` 时严格相等；
  - 无 `active_thread` 时视图线程视为主线程，接受 `null` 与 `_main`。
- 处理的事件：`model.delta`、`tool.start/delta/end`、`run.started/run.finished`、
  `group.message`、`workflow.step`、`thread.*`、`shell.state`（连接态与重连重同步）。
- **run 生命周期按 run id 关联**：只有对话回合命令（`name ∈ chat.send/chat.resume`）的
  `run.started` 建流——管理命令 / 槽写 run 不建流（`origin` 的 `command` 同时覆盖对话回合与
  管理命令，须看 `name`）；`run.finished` 按 run id 关联在途回合收束（无关终局忽略、不重拉），
  周期 run 不处理。
- `thread.*` / `group.message` 触发的是一次静默快照（quiet reload，保留消息、只出顶部细呼吸条）。

## 长列表窗口化

> 200 条只渲染一个窗口；滚顶拉上一窗、到窗口底拉下一窗。渲染窗口上限 `MAX_WINDOW`（600）：
> 超过即回收远端——上翻回收底部、下翻回收顶部——长历史下常驻 DOM 有界。远端回收在滚动容器
> 里按高度差补偿滚动位置；每帧只做一种单方向 DOM 变更，补偿才准确。窗口右端未到列表末端时
> 不算「贴底」，「↓」胶囊会先把窗口恢复到最新一窗再贴底。

## 运行

```sh
npm install                       # 生成 / 更新 package-lock.json
npm test                          # 纯函数视图层 + 服务协议测试（node --test）
npm run typecheck                 # tsc --noEmit（include 只含 execute/web）
node ../../tools/build-ui.mjs ui-chat   # 打包 execute/web/dist/entry.js
node tools/e2e-smoke.mjs          # 宿主装配 E2E（pack/seed → start → 命令面 → stop → verify）
```

## `.worldignore`

声明 `test/`、`tools/` 与 `execute/web/dist/` 不入世界；其余（`plugin.json` / `package.json` /
`package-lock.json` / `README.md` / `execute/`（含 `execute/web/` 源码）/ `terms/`）随源码入世。
本插件无世界数据、零 schema，故无 `schema/` 目录。
