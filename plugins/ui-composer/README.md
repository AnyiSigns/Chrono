# ui-composer（底部输入卡）

底部输入区子应用（slot = `composer`）：文本输入 + 附件 + 模型 / 推理强度 / 权限档 +
发送 / 终止，以及输入卡下方的上下文用量行。本插件是独立包 / 独立进程 / 独立端口，
自带浏览器静态资源、自己的入站客户端连接、自己的 `/events` SSE。

- 能力类：`ui-composer`（`ping` 占位，UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：无（不发 `eff`）；命令 / 提交一律按名经入站面（`input.read` / `config.read` /
  `chat.send` / `model.profile`）。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema**——省略 `plugin.json.schema`）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / SSE / socket / 静态服务全自实现。

## 数据路径

1. 浏览器调本插件 `POST /api/command`，body `{name, args, thread?}`；本插件服务经自己的入站连接
   发 `command` 帧（按名调用，不需 pins），宿主回投影值。
2. 写一律经入站面 `submit`：`POST /api/submit`，body `{directives, thread?}`。
3. 读-改-写：`input.read` 取回整份 `body.slots`，只覆盖本线程键（`active_thread`，缺省 `_main`）
   后整份 `put` + `add_gen`；`config.read` 取回整份配置，只改本插件负责的字段后整份 `put` + `add_gen`。
4. 发送 = 写 `chat.message` 槽（`text` + `attachments`）后按名调无参命令 `chat.send`，信封带
   `thread = active_thread`；终止 = 入站协议 `cancel{run}`，`run` 取自匹配当前线程的 `run.started`。
5. 附件字节经壳的 `api.asset.put(mime, bytes)` 入库，世界只存 `{kind:'asset',sha256,mime,size}`
   引用；可解析的文本格式额外内联 `text`。

## 待发队列与上下文用量

- **待发队列**：仅本进程内存，per-thread 键控。回合进行中提交的消息只入所属线程的队列；
  收到该线程的 `run.finished` 后自动取队首写槽并续发（与当前查看线程无关）。计数随
  `active_thread` 切换，刷新即丢；每条可移除。
- **上下文用量行**：数据源为宿主事件 `context.assembled`（按线程过滤取当前线程最近一次）。
  形如 `上下文 42k / 128k`（`tabular-nums`）；<75% 次级字、≥75% warning 前景字、
  ≥100% danger 前景字 + 「上下文已满」。无事件时不渲染该行；只读、不做压缩动作。
- **推理强度**：选项先读用户配置（`providers.<vendor>.models.<model>.reasoning`）；配置缺档位时
  按名调 `model.profile` 拉档案并落配置；档案也缺档位则隐藏按钮；档位值全同时折叠为单开关。
- **权限档**：四档 `auto` / `severe` / `review` / `deny`，全局写配置 `permission`。

## 子应用入口契约

```
GET /entry.js   → ES module，导出 mount(root, api) -> {unmount()}；另导出 contract = "1"
GET /<name>.js  → 浏览器视图层模块（扁平白名单名，源码 ESM 直接服务，不自打包）
GET /events     → 本插件自己的 SSE：把宿主事件原样重播给本页
POST /api/command → 入站 command（input.read / config.read / chat.send / model.profile…）
POST /api/submit  → 入站 submit（directive(s) + thread）
POST /api/cancel  → 入站 cancel（终止指定 run）
GET  /api/asset/<sha256>[/<mime>] → 入站 asset.get，直接回原始字节（缩略图 src 用）
                                  （走路径段而非查询串：壳反代 `/p/<id>/*` 不保留查询串）
GET  /api/state   → 本插件入站连接态
```

- 浏览器侧 `api` 由壳提供；本插件借用 `api.uiState`（`active_thread` 跨 slot 视图态）与
  `api.asset.put`（附件字节入库），其余命令 / 提交 / 终止 / 取字节走本插件自己的入站连接。
- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v1.svg`（图标）、
  `/assets/messages.v1.json`（错误码人话）；零硬编码色值，界面文案集中在 `execute/web/messages.js`。

## 运行

```sh
npm test                          # 纯函数视图层 + 服务协议测试（node --test）
node tools/e2e-smoke.mjs          # 宿主装配 + HTTP E2E（pack/seed → start → HTTP → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/`（含 `execute/web/`））随源码入世。本插件无世界数据、零 schema，故无 `schema/` 目录。
