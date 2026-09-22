# ui-threads（线程顶栏）

对话页的**线程顶栏**：常态 0 高度，鼠标进入顶部热区才 overlay 展开线程标签
（对话 → 会话标题 / 子代理 / 群聊 / 工作流，外加「待办 N」位），点击切换当前视图线程。
本插件是 `topbar` 槽子应用，独立包 / 独立进程 / 独立端口，自带浏览器静态资源、
自己的入站客户端连接；事件经壳 `/events` 总线（`api.events`）订阅。

- 能力类：`ui-threads`（`ping` 健康占位 + `threads.state` 标签装配；UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；只读命令按名经入站面调用，切换只走壳的 `api.uiState`。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`，宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / socket 全用 Node 内置，浏览器层源码 ESM 直接服务、不自打包。

## 提供哪些命令

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `threads.state` | `eff ui-threads threads.state ["g",["ids"]]` | 入口 term 只传投影切片 `ctx.ids`；服务从传入投影取 `session` 线程字段（`kind` / `parent` / 标题 / `status` / `pending`）与 `todo` 待办清单，返回标签数据 |

- **投影读在入口 term，服务不读投影**：`threads.state` 的入口 term 读 `ctx.ids` 随 eff args 传入，
  服务只做装配（内核 term 语言无对象构造 / 无算术，装配下沉到服务）。
- 本插件**无 pins**，`eff` 经宿主的**自能力路由**解析到本插件自己的端点行（能力类 = 自身 `implements`），
  不构成跨身份依赖。
- 命令无参；写类操作不存在（切换线程是纯前端视图态）。

## 标签与隔离

- **来源 = `session` 会话列表**：每个线程一个标签，顺序 = 线程树（`main` 在前，子线程按 `parent` 归组、
  同级保持会话列表原序）。
- **文案**：缺省标题（`新对话` / 空）在顶栏显示为「对话」；会话标题更新后显示标题；
  子代理 / 群聊 / 工作流各自的缺省兜底为「子代理」/「群聊」/「工作流」。
- **按父会话隔离**：以当前 `session` `current` 上溯到的 `main` 线程为根，标签集合 = 该根 + `parent` 闭包内的线程；
  切换父会话即换一组标签，多会话并行时不混入别人的子代理。
- **待办标签位（`todo`）**：当前父会话有未完成项（`pending` / `in_progress`）时追加「待办 N」，
  点开显示只读清单；全部 `completed` / 清空后标签消失。
- **状态角标**：待审批（`pending.approval` / `pending.question` > 0）、运行中、完成、失败——
  同源 `thread.updated` 的 `status` / `pending` 字段，**不另订宿主 `run.*`**。

## 位置与显隐

- 位置：侧边栏右侧、`main` 顶部；常态 0 高度（不推挤布局），鼠标进入顶部 8px 热区才 overlay 展开，离开隐藏。
- **hover 意图延时 150ms 出 / 300ms 收**（防鼠标划过顶部误触）；收起期间回入即取消收起。
- 层级用 `--z-topbar`；被断线横幅 / 设置模态遮罩盖住时自然不可达（无需特判）。
- **已知例外**：本顶栏为**纯 hover 交互**——**键盘不可达、触屏不可用**（已登记的全局设计例外）；
  会话切换仍可经侧栏完成。纯 hover、键盘不可达、触屏不可用为本插件的登记限制。

## 切换与未读

- 点击标签 → `api.uiState.set('active_thread', threadId)`；`ui-chat` 订阅该键并按 `kind` 重拉对应线程。
- **`current` ↔ `active_thread` 单桥**：侧栏 `session.select` 落账后 `session` 发 `thread.updated`（含 `current` 变），
  本插件据此重算 `threads.state`，并**仅当 `current` 变了**（或尚未选定）才把 `active_thread` 重置到它。
- **未读角标 = 内存计数**（视图态不落世界）：`group.message` 到达且线程 ≠ `active_thread` 时 +1；
  切入该线程即清零；**刷新即丢**（登记限制，与消息流内未读锚点分工不同）。

## 子应用入口契约

```
GET /entry.js     → ES module，导出 mount(root, api) -> {unmount()}；另导出 contract = "1"
GET /<name>.js    → 浏览器视图层模块（扁平白名单名，源码 ESM 直接服务）
POST /api/command → 入站 command（只读命令 `threads.state`）
```

- 事件不经本端口：浏览器侧经壳 `api.events` 订阅宿主事件与 `shell.state` 连接态。

- 视图层模块：入口编排 `entry.js`；纯逻辑 `threads-model.js`（线程树 / 隔离 / 角标，服务侧装配共用）、
  `hover-intent.js`（hover 延时状态机）、`unread.js`（未读计数）、`bridge-state.js`（`active_thread` 单桥）、
  `messages.js`（文案单一来源）；渲染 `styles.js` / `dom.js`。
- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v2.svg`（线性图标）；
  组件样式只引 token，零硬编码色值、无内嵌图标与 emoji。
- 端口默认 `8793`（`CHRONO_UI_PORT_UI_THREADS` 可覆盖），绑定 `127.0.0.1`；浏览器经壳反代
  `/p/ui-threads/*` 访问，本插件不自开对外端口。
- 失败隔离：本 slot 加载失败只在本 slot 内渲染占位，不影响 `main` / `sidebar`。

## 运行

```sh
npm test                  # 纯函数视图层 + 服务装配 + 协议级驱动测试（node --test）
node tools/e2e-smoke.mjs  # 宿主装配 E2E（pack/seed → start → HTTP → stop → verify/replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/`（含 `execute/web/`）/ `terms/`）随源码入世。本插件无世界数据、零 schema，故无 `schema/` 目录。
