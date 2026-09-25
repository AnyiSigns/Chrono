# ui-composer（底部输入卡）

底部输入区子应用（slot = `composer`）：文本输入 + 附件 + 模型 / 推理强度 / 权限档 +
发送 / 终止，以及输入卡下方的上下文用量行。浏览器半边是注册进壳单一 React 运行时的模块，
业务状态住 React-free store；服务半边只做健康占位与客户端半边产物只读交付。

- 能力类：`ui-composer`（方法 `ping`、`client.read`；UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；命令 / 提交经壳 api 按名调（`ctx.command` / `ctx.submit` /
  `ctx.cancel`），不再自建 HTTP 面。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 构建：`npm ci` + `node execute/build.mjs`（esbuild JS API，externalize 壳 vendor），
  产物落 `execute/web/dist/entry.js`；`dist/` 被 `.worldignore` 排除，故由插件自交付。

## 客户端半边

- `execute/web/entry.tsx`：`export const contract = '2'` + `register(ctx)`，把 App 注册进
  `composer` slot；组件经 `ctx.useStore` 绑定 store，只渲染快照、调动作。
- 叶子纯模块（零 react import，单测覆盖）：`model.ts` / `attach.ts` / `dropdown.ts` /
  `messages.ts` / `run-model.ts`。DOM 构建层（`dom` / `styles` 注入 / `entry.js`）退休为
  React 组件与 `<style>` 注入。
- 交付：壳经 `bridge.command('ui-composer.client.read', { path })` 取字节，以
  `/assets/ui/ui-composer.js` 同源服务。方法只接受包内相对 `.js` 路径，拒绝绝对路径 /
  盘符 / 反斜杠 / `..` / 空段。

## 数据路径

1. 浏览器经壳 api 调命令（`ctx.command(name, args, {thread})`），宿主按名路由回投影值。
2. 写经壳 api `ctx.submit(directives, {thread})`。
3. 读-改-写：`input.read` 取回整份身份视图，用 `body.slots` 只覆盖本线程键（`active_thread`，缺省 `_main`）
   后整份 `put` + `add_gen`（读到的 `active` 作 `expect_active`）；`config.read` 同理取回整份配置 body，
   只改本插件负责的字段后整份 `put` + `add_gen`。读到代码世代回落 body（含 `tree` 键）时回未就绪并退避重试。
4. 发送 = 写 `chat.message` 槽（`text` + `attachments`）后调无参命令 `chat.send`，信封带
   `thread = active_thread`；终止 = `ctx.cancel(run)`，`run` 取自匹配当前线程的 `run.started`。
   - **前置门禁**：`uiState.active_workspace` 为 `null`（无工作区）→ 提示「请先添加工作目录」；模型未配置 →
     提示「请先选择模型」；两者都不落回合。
   - **无当前会话自动建线程**：`active_thread` 为空时以新 id 乐观置 `active_thread`，槽带
     `workspace_id`（取 `active_workspace`）与 `conversation_id`（新 id），由 `chat.send` 落账时原子建会话。
5. 附件字节经壳 `ctx.asset.put(mime, bytes)` 入库，世界只存 `{kind:'asset',sha256,mime,size}`
   引用；可解析的文本格式额外内联 `text`。缩略图经 `ctx.asset.get(sha256)` 转 data URL。

## 待发队列与上下文用量

- **待发队列**：仅本进程内存，per-thread 键控。回合进行中提交的消息只入所属线程的队列；
  收到该线程**本回合 run**（按 run id 关联）的 `run.finished` 后自动取队首写槽并续发
  （与当前查看线程无关）；宿主的其它 run（如 `origin:'periodic'` 的维护类 run）不构成回合信号。
  计数随 `active_thread` 切换，刷新即丢；每条可移除。
- **上下文用量行**：数据源为宿主事件 `context.assembled`（按线程过滤取当前线程最近一次）。
  形如 `上下文 42k / 128k`（`tabular-nums`）；<75% 次级字、≥75% warning 前景字、
  ≥100% danger 前景字 + 「上下文已满」。无事件时不渲染该行；只读、不做压缩动作。
- **推理强度**：选项先读用户配置（`providers.<vendor>.models.<model>.reasoning`）；配置缺档位时
  按名调 `model.profile` 拉档案并落配置；档案也缺档位则隐藏按钮；档位值全同时折叠为单开关。
- **权限档**：四档 `auto` / `severe` / `review` / `deny`，全局写配置 `permission`。

## 运行

```sh
npm test                          # 纯模块单测 + 客户端交付契约 + 服务协议（node --test）
npm run typecheck                 # tsc --noEmit
node tools/e2e-smoke.mjs          # 宿主装配冒烟（pack/seed → start → 声明 → stop → verify）
```

## `.worldignore`

声明 `test/`、`tools/` 与 `execute/web/dist/` 不入世界；其余（`plugin.json` / `package.json` /
`package-lock.json` / `README.md` / `execute/`（含 `execute/web/` 源码）/ `terms/`）随源码入世。
本插件无世界数据、零 schema，故无 `schema/` 目录。
