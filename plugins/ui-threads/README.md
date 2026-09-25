# ui-threads（线程顶栏）

对话页的**线程顶栏**：常显的线程标签条
（对话 → 会话标题 / 子代理 / 群聊 / 工作流），标签行下方挂只读**待办清单面板**，
点击标签切换当前视图线程。
本插件是壳的 `topbar` slot 客户端半边，注册进壳的单一 React 运行时；无独立端口、无 HTTP 面，
事件经壳 `/events` 总线（`api.events`）订阅。

- 能力类：`ui-threads`（`ping` 健康占位 + `threads.state` 标签装配 + `client.read` 客户端半边交付；
  UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；只读命令按名经宿主路由调用，切换只走壳的 `api.uiState`。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`，宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖；构建用 `esbuild`（devDependency）。

## 提供哪些命令

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `threads.state` | `eff ui-threads threads.state ["g",["ids"]]` | 入口 term 只传投影切片 `ctx.ids`；服务从传入投影取 `session` 线程字段（`kind` / `parent` / 标题 / `status` / `pending`）与 `todo` 待办清单，返回标签数据 |
| `ui-threads.client.read` | `eff ui-threads client.read ["g",["path"]]` | 只读：按包内相对 `.js` 路径回 `{path,text}`（壳取客户端半边字节用）；路径穿越防护 fail-closed |

- **投影读在入口 term，服务不读投影**：`threads.state` 的入口 term 读 `ctx.ids` 随 eff args 传入，
  服务只做装配（内核 term 语言无对象构造 / 无算术，装配下沉到服务）。
- 本插件**无 pins**，`eff` 经宿主的**自能力路由**解析到本插件自己的端点行（能力类 = 自身 `implements`），
  不构成跨身份依赖。

## 客户端半边（自产自交付）

```
execute/web/entry.tsx   → 壳经 ui-threads.client.read 取字节，以 /assets/ui/ui-threads.js 同源服务
contract = '2'；register(ctx) 把顶栏组件注册进 topbar slot；不再导出 mount
```

- 构建：`plugin.json.build` = `npm ci` + `node execute/build.mjs`（esbuild JS API 打包），
  产物落 `execute/web/dist/entry.js`；externalize 壳 vendor（react / react-dom / jsx-runtime /
  use-sync-external-store），单文件、无 code splitting。
- 交付：产物被 `.worldignore` 排除，壳经只读命令 `ui-threads.client.read` 取字节并缓存；
  路径只接受包内相对 `.js`，拒绝绝对路径 / 盘符 / 反斜杠 / `..` / 空段。
- 视图层模块：入口编排 `entry.tsx`；纯逻辑 `threads-model.ts`（线程树 / 隔离 / 角标，服务侧装配共用）、
  `unread.ts`（未读计数）、`bridge-state.ts`（`active_thread` 单桥）、
  `messages.ts`（文案单一来源）、`threads-store.ts`（React-free store + fold）；样式 `styles.ts`。
  叶子纯模块零 react import（可 grep 断言）。
- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v2.svg`（线性图标）；
  组件样式只引 token，零硬编码色值、无内嵌图标与 emoji。

## 标签与隔离

- **来源 = `session` 会话列表**：每个线程一个标签，顺序 = 线程树（`main` 在前，子线程按 `parent` 归组、
  同级保持会话列表原序）。
- **文案**：缺省标题（`新对话` / 空）在顶栏显示为「对话」；会话标题更新后显示标题；
  子代理 / 群聊 / 工作流各自的缺省兜底为「子代理」/「群聊」/「工作流」。
- **按父会话隔离**：以当前 `session` `current` 上溯到的 `main` 线程为根，标签集合 = 该根 + `parent` 闭包内的线程；
  切换父会话即换一组标签，多会话并行时不混入别人的子代理。
- **待办清单面板（`todo`）**：当前父会话有未完成项（`pending` / `in_progress`）时出现在标签行下方：
  头部为「{done}/{total} 个待办已完成」进度行（点击展开 / 收起，**默认收起**，展开态切换线程不重置），
  条目带只读复选框（completed 打勾并划线，in_progress 中心点）；全部 `completed` / 清空后面板消失。
  清单出现 / 更新时播放一次「展开→收起」提示动画（`TODO_PEEK_MS`，展开停留后回落默认收起态），
  展开 / 收起用 grid 行 `0fr ↔ 1fr` + 内容淡入淡出过渡；`prefers-reduced-motion` 下取消过渡。
- **状态角标**：待审批（`pending.approval` / `pending.question` > 0）、运行中、完成、失败——
  同源 `thread.updated` 的 `status` / `pending` 字段，**不另订宿主 `run.*`**。

## 位置与显隐

- 位置：侧边栏右侧、`main` 顶部；**常显**，占正常文档流（推挤消息区下移），无任何内容可显示时整栏不渲染（0 高度）——无任何会话（`empty`）同此，不渲染占位文案。
- 键盘：标签与待办头部均为原生 `<button>`，可 Tab 到达并 Enter / Space 触发；
  根容器 `role="region"` + `aria-label`，标签带 `aria-label` / `title`，未读与角标并入 aria 文案。
- 层级用 `--z-topbar`；被断线横幅 / 设置模态遮罩盖住时自然不可达（无需特判）。

## 切换与未读

- 点击标签 → `api.uiState.set('active_thread', threadId)`；`ui-chat` 订阅该键并按 `kind` 重拉对应线程。
- **`current` ↔ `active_thread` 单桥**：侧栏 `session.select` 落账后 `session` 发 `thread.updated`（含 `current` 变），
  本插件据此重算 `threads.state`，并**仅当 `current` 变了**（或尚未选定）才把 `active_thread` 重置到它。
- **未读角标 = 内存计数**（视图态不落世界）：`group.message` 到达且线程 ≠ `active_thread` 时 +1；
  切入该线程即清零；**刷新即丢**（登记限制，与消息流内未读锚点分工不同）。

## 运行

```sh
npm install               # 生成 lockfile（含 esbuild devDependency）
npm run build             # node execute/build.mjs → execute/web/dist/entry.js
npm run typecheck         # tsc --noEmit
npm test                  # 纯函数视图层 + store fold + 服务装配 + client.read 防护 + 协议级驱动（node --test）
node tools/e2e-smoke.mjs  # 宿主装配 E2E（pack/seed → start → commands → stop → verify/replay）
```

## `.worldignore`

声明 `test/`、`tools/` 与 `execute/web/dist/` 不入世界；其余（`plugin.json` / `package.json` /
`package-lock.json` / `README.md` / `execute/` / `terms/`）随源码入世。本插件无世界数据、零 schema，故无 `schema/` 目录。
