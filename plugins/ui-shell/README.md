# ui-shell（浏览器唯一入口 + 布局壳）

Chrono 的**唯一对外主端口**：浏览器只连它。壳持有主端口与入站桥，负责布局槽装载、
子应用同源反代、设计资源（token / 图标 sprite / 文案表）唯一来源、S0 启动态、
S6 断线横幅与全局 toast。壳不渲染业务面板、不做业务判定、不读投影。

- 能力类：`ui-shell`（`ping` 占位，UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：`{"host":"host"}` —— 指向保留身份 `host`，只用于 `host.source.read` 取
  headless 入口字节（壳是唯一加载方）。
- 状态档：`recomputable`（③ 可重算；挂载表 / headless 清单 / 端口都不进世界）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / SSE / socket 全用 Node 内置。

## 路由

```
GET  /                        壳页面（S0 启动 → 各 slot 淡入）
GET  /assets/tokens.v1.css    共享设计 token（唯一来源，无组件样式）
GET  /assets/icons.v2.svg     线性图标 sprite（Lucide 子集，唯一来源）
GET  /assets/messages.v1.json 错误码 → 人话文案表（唯一来源）
GET  /favicon.svg             站点图标（字母 C 字标）
GET  /assets/lib/<name>.js    壳页面共享前端库（ui-state / toast / theme / boot-mode / shell）
GET  /assets/headless/<id>.js headless 入口（经 host.source.read 取字节、同源服务，不占 slot）
GET  /p/<id>/*                挂载表内 id → 反代子应用端口；表外 id（如 mcp）→ 宿主 forward 帧
GET  /events                  SSE：宿主事件原样重播 + 壳状态 + 壳合成断连 / 重连事件
POST /api/theme               写 config.ui.theme（读-改-写；落 config 用 day/night/system 词表）
POST /api/submit              转入站 submit（body 含 directive(s) + thread）
POST /api/command             转入站 command（body 含 name / args + thread）
POST /api/asset               转入站 asset.put（body 含 mime / bytes(base64)）
GET  /api/asset?sha256=…      转入站 asset.get
POST /api/cancel              发协议 cancel{run}
GET  /api/state               壳运行态（连接态 / 主题偏好 / 引导模式）
```

`/p/<id>/<cmd>` 表外路径映射为命令名：路径段以 `.` 连接并保证带 `<id>.` 前缀
（`/p/mcp/discover` → `mcp.discover`，`/p/mcp/tools/list` → `mcp.tools.list`）。

壳自有的页面 / 静态 / 模块响应一律 `cache-control: no-store`：降级内容（如空 sprite）若被
浏览器启发式缓存，`<use href="/assets/icons.v2.svg#…">` 会长期解析不到目标而静默留白。
降级不阻塞功能，但会落一行 `asset fallback: <name>` 日志（`serveAsset`）。

## 挂载表与 headless 清单

- `state/ui-mounts.json` = `[{id, path, slot, port}]`；启动无表 / 坏表则写默认值。
  默认：`ui-sidebar/sidebar/8791`、`ui-chat/main/8788`、`ui-approval/dock/8789`、
  `ui-composer/composer/8790`、`ui-threads/topbar/8793`、`ui-settings/overlay/8792`。
  子应用端口可 `CHRONO_UI_PORT_<ID>` 覆盖（ID 大写、非字母数字转 `_`）。一插件一 slot；
  增删插件只改表，不改壳代码。
- `state/ui-headless.json` = `[{id, entry}]`；`entry` 为插件包内路径。headless 不进挂载表、
  不给布局位、不占端口；壳经 `host.source.read` 取字节并以同源静态路径服务。默认
  `{id:"ui-notify", entry:"web/entry.js"}`。
- **headless 字节缓存失效**：壳按宿主 `identity.changed` **逐身份**判定——仅当该身份在 headless 清单内
  且 `kind === 'code'`（代码世代 `active` 变，含新增 / 退役）时删除缓存并重取；`kind === 'data'`
  （数据世代变更）不失效，因为不改入口字节。
- 主端口默认 8787，`CHRONO_UI_PORT` 覆盖；全部绑定 `127.0.0.1`。

## 子应用契约

`GET /entry.js` 导出 `mount(root, api) -> {unmount()}`；可选导出 `contract`（字符串，
与壳契约版本 `"1"` 不符即 `ui_version_mismatch`）。

```text
api = {
  tokens: { css, icons, messages },   // 三个唯一来源路径
  theme:  { get(), set(pref), subscribe(cb) },   // pref ∈ light / dark / system
  navigate(path),
  slot,                                // 本子应用所在 slot 名
  submit(directive | directives, opts) // 转入站 submit
  command(name, args, opts)            // 按名调命令
  cancel(run)                          // 真取消指定 run
  asset:  { put(mime, base64), get(sha256) }
  events: { subscribe(topic, cb), onAny(cb), connected() }
  toast({ tone, text, action? })       // tone ∈ info / success / warning / danger
  uiState: { get(k), set(k,v), subscribe(k,cb), keys }
}
```

- `uiState` 键空间（壳登记）：`active_thread` / `active_workspace` / `boot_mode` / `settings_open`。纯前端内存态，
  跨 slot 广播，刷新即丢，不落世界。新增键先登记。
- 失败隔离：子应用加载失败只在自身 slot 内渲染占位卡（`ui_unreachable` / `ui_boot_failed` /
  `ui_version_mismatch` + 手动重试），不影响其它 slot。
- 事件按 `impl` 命名空间；壳合成事件 `shell.disconnected` / `shell.reconnected` 与壳状态
  `shell.state` 同经 `/events` 下发。
- **事件总线唯一**：浏览器对壳只维持这一条 `/events` SSE；子应用与 headless 一律经
  `api.events` 订阅，不再各自开私有 SSE（HTTP/1.1 每源并发上限 6，多子应用各开一条会挤占模块 / 资源请求）。
  插件服务若需自报事件，走协议 `event` 帧经宿主广播、壳转发，命名空间仍是原始 `impl`。

## 无配置判据

壳经入站 `command config.read` 取返回的身份视图：`body.providers` 里存在至少一个已启用模型条目 ⇒
`uiState.boot_mode='ready'`；否则 `'onboarding'`。壳自身不读投影。`boot_mode` 写者恒为壳，
其它插件只订阅。

重推触发点（壳内部）：初次连接与重连（`config.read` 读回）、启动后延迟首读、
`/api/submit` 命中 config 写（`add_gen` 的 `id === 'config'`）——写回 `accepted` 时记下 run，
run 终局（`run.finished` / 终局 result 帧）后读回，写同步返回时立即读回；重推经 `shell.state`
广播，壳页面收到后重跑判据并广播 `uiState.boot_mode`。主题词表：DOM / SSE / 运行态用
`light` / `dark` / `system`，只有落 config 时换 `day` / `night` / `system`。

## 全局 toast

壳渲染（右下角堆叠、最多同屏 3 条、超出排队）。触发两路：子应用 `api.toast`；壳按内置规则
（断线 / 重连 / token 降级）。info/success 2.5s、warning/danger 4s；带 action 不自动消失；
hover 暂停、可关闭；`aria-live` 按 tone 取 `status` / `alert`。

## 文案表维护义务

`execute/web/messages.v1.json` 是**全部对外错误码 → 人话**的唯一来源；各插件禁硬编码人话。
结构 `{ "<code>": { "title": "…", "body": "…", "action": "…"? }, "locale": … }`。
须覆盖前缀：`ui_*` / `model_*` / `discover_*` / `approval_*` / `sandbox_*` / `guard_*` /
`tool_*` / `mcp_*` / `plugin_*`；未登记码按 `unknown` 兜底。文案遵循全局文案规范
（无感叹号、不道歉、省略号用 `…`）。新增码先登记再入表。

## 图标 sprite 维护

`execute/web/icons.v2.svg` 只含全局设计语言登记的子集，24×24 viewBox、stroke 1.5、
round cap/join、`currentColor`。业务插件以 `<use href="/assets/icons.v2.svg#<name>">` 引用，
禁止内嵌图标或 emoji。重新生成：`node tools/gen-icons.mjs <lucide-static 包目录>`。

图标子集有增删时按内容升版文件名（`icons.v2.svg` → `icons.v3.svg`，同步 `routes.ts` /
`http-server.ts` / `assets.ts` / `gen-icons.mjs` 与各插件 `dom.js` 的引用）：新 URL 绕开
浏览器里可能残留的旧副本，是 `no-store` 之外的第二道保险。

## 运行

```sh
npm test                          # 协议级 / 单元测试（node --test）
node tools/e2e-smoke.mjs          # 宿主装配 + HTTP E2E（pack/seed → start → HTTP → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`（含 `execute/web/`））随源码入世。
