# #31 `tool-browser`（浏览器自动化）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 31 / `tool-browser` |
| 职责 | 浏览器自动化，一个工具 `webbrowser`：**会话化**导航 / 元素交互 / 文本抽取 / 截图；会话状态住宿主侧 ③（进程内），不进世界 |
| 依赖 | `->` 25（pins：`caps.net` 声明级钳制 + 资源上限；**浏览器进程由本插件直接 spawn 自管、不经 #25 `exec`**，见「隔离」）（2026-09-20 修订）；**`host` pin**（截图 / 下载经 `host.asset.put`，S1 已落地）（2026-09-20 修订）；`<-` 27（pins：按工具类 `tool-browser` 派发） |
| 成员 | execute, schema（无 terms：服务经**反向帧 `port.call`** 调 #25 做 `caps.net` 声明级钳制；**浏览器进程自管**，见「隔离」；`docs/protocol.md` §2.4）（2026-09-20 修订） |
| 能力类·方法 | `implements: ["tool-browser"]`，`methods: {"tool-browser":["describe","invoke"]}`（**类名 = 身份名**；`describe` 回工具名 `webbrowser`，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | 无 |
| schema | `schema/tool-browser.json`（引擎 `impl` / 无头 / 视口 / 超时 / 会话空闲回收 TTL / 截图格式 / 是否允许下载）；**下载落点 = 资产面（`host.asset.put`），与 `caps.fs` 无冲突（不走 fs）**（2026-09-20 修订） |
| 机制 | 见下「`webbrowser` / 会话 / 隔离」 |
| 边界 | 不做：绕过 guard / sandbox / **无状态抓取（归 30 `webfetch`）** / 工具语义判定（归 26）/ 派发（归 27）/ 写世界（截图走资产引用，见下） |
| 验收 | 1) 同一会话内 `navigate` → `click` → `extract` 保持页面状态；2) `close` 后无残留进程 / 句柄；3) 会话空闲超 TTL 自动回收；4) 与 30 职责不重叠（有会话 = 本插件，无状态 = 30）；5) `caps.net` 声明级钳制（需求 `all`），越档 `net_denied`；6) 换引擎（Playwright ↔ CDP）不改 #27 / 模型侧 |
| 状态 | 细节设计（2026-09-19）：按 `tool` 端口契约展开；工具集按用户口径定为 `webbrowser`；**pins 更正**：v1 不解析密钥，去掉总表 §1.7 的 `24`（见「跨插件登记」） |

## `webbrowser`

单一工具名，用 `action` 分档（`describe` 的 `modes` 列出）：

| `action` | args（要点） | 结果 |
| --- | --- | --- |
| `open` | `session?`（缺省新开）/ `viewport?` | `{session}` |
| `navigate` | `session` / `url` / `wait_until?` | `{status, url, title}` |
| `click` | `session` / `selector` | `{ok}` |
| `type` | `session` / `selector` / `text` / `submit?` | `{ok}` |
| `press` | `session` / `key` | `{ok}` |
| `wait_for` | `session` / `selector?` / `ms?` | `{ok}` |
| `extract` | `session` / `selector?`（缺省正文）/ `attr?` | `{text}` / `{value}` |
| `screenshot` | `session` / `full_page?` / `format?` | `{asset:{kind:'asset',sha256,mime,size}}`（见下） |
| `close` | `session` | `{closed}` |

- **`idempotent:false`**：有会话 / 有状态，永不缓存、永不 memo（与 #30 的无状态抓取相对）。
- `caps` 用 **`{fs:{read,write}, net}` 对象形**（D11；与 #25 一致）：`caps.net = "all"`；`caps.fs = {read:"none", write:"none"}`（**截图与下载都不落工作区，走资产引用（`host.asset.put`），与 `caps.fs` 无冲突**）（2026-09-20 修订）。
  - **net 只认字符串** `none` / `limited` / `all`（与 sandbox `tiers.rs` 的 `NetScope::parse` 同口径；布尔 / 畸形按未声明处理）。
    浏览器可导航任意 host，**声明需求是 `all`**；故 `severe`(limited) / `review` / `deny` 均越档 `net_denied`，只有 `auto`(all) 放行。
  - **`limited` 对动态导航无 host 语义**（无法逐 host 拦截浏览器导航），故只做**声明级**钳制、实现尽力。
  - **`bag.grant` 不适用**：浏览器进程自管、不经 #25 `exec`，一次性 grant 无法放宽 net；schema 不声明、运行期不消费、也不透传。
- `navigate` 仅接受 `http(s)`：`file:` / `javascript:` 等非 http(s) 一律 `navigate_failed`；**不做 host 过滤**（登记为已知口径）。
- `press` 向当前焦点元素派发**真实按键**（playwright `keyboard.press` / CDP `Input.dispatchKeyEvent` keyDown+keyUp），触发浏览器默认行为；不合成 DOM `KeyboardEvent`。
- `wait_for` 的 `ms` 两引擎统一：等满请求毫秒数；`ms` 超单动作超时回 `tool_timeout`（不静默缩短）。

## 渲染（`describe.render`，本轮定）

```jsonc
{ "form": "card", "label": "webbrowser",
  "summary": "{action}  {url}",                  // 折叠态：动作 + 目标 URL（无 url 的动作留空）
  "tone": "plain",
  "detail": { "kind": "json" },                 // **静态**：单工具只能声明一个展开态渲染器
  "live": false }
```

- **`detail.kind` 必须静态**：`webbrowser` 是**单个工具**，`describe.render` 只能声明一个 `detail.kind` ⇒ 固定 `"json"`（闭集里的通用兜底，不空白、不报错），**不能按 action 变化**。若要逐 action 各自的展开态渲染器，须**按 action 拆成多个工具**（各带自己的 `render`），本轮不做。

| `action` | 结果载荷 | 渲染 |
| --- | --- | --- |
| `navigate` / `extract` | `{status,url,title}` / `{text}` | 静态 `json`（短文本 / 结构化结果） |
| `screenshot` | `{asset:{kind:'asset',…}}` | #18 的**资产图片渲染路径**（点开 lightbox），不依赖 `detail.kind` |
| `click` / `type` / `press` / `wait_for` / `open` / `close` | `{ok}` / `{closed}` 等短结果 | 静态 `json` |

- 默认收缩显示动作 + 目标；展开显示对应结果。截图走资产引用（同 #18 的图片渲染路径），**不进世界**。

## 会话

- **会话状态住宿主侧 ③**（本服务进程内 + `state/plugins/tool-browser/`，H4 ③ 目录），**不进世界、不参与哈希**；服务重启 / 代码换代 ⇒ 旧会话失效（会话不跨换代）；**浏览器进程同归本插件自管**（与「隔离」一致）（2026-09-20 修订）。
- **生命周期**：`open` 起 → 空闲超 `TTL` 自动回收 / `close` 显式关 / 服务退出时全关（`SIGTERM` / `SIGINT` 优雅停机 + `process.on('exit')` 同步 `killAllSync` 硬杀兜底；进程随宿主断连自退出，`docs/protocol.md` §2.7）；不泄漏浏览器进程。
- 会话 id 由服务分配（**确定性**：由 `run` + 序号派生，不用随机，保可回放；`at` 由 bag 传入）。

## 隔离

- **浏览器进程由本插件直接 spawn 自管**（与 #25「长驻交互会话归 31 自管」一致，**不经 #25 `exec`**）；**风险登记：保留例外（同 #37 模式）**；`caps.net` **声明级钳制、实现尽力**（需求 `all`，`severe`(limited) / `review` / `deny` 越档 → `net_denied`）；**#26 对 browser 工具按『危险操作』规则判升级**（`auto` 档对含表单提交 / 下载的 action 默认 `escalate`）（2026-09-20 修订）。
  - **登记：sandbox 无独立「查 net」方法**（`capabilities` 只自述强制面），真正的 net 判定在本插件内完成；本插件**消费** `capabilities.enforcement.net` 自述，为 `none` 时 fail-closed，缺失 / 未知以本插件判定为准。
- 引擎 `impl` 住 schema（`playwright`：自带 Chromium / `cdp`：连系统浏览器）；换引擎不改 #27 与模型侧（工具名 / args 不变）。
- 平台 / 运行时不可用 → `browser_unsupported`（明确失败，不静默降级）。
- **登记：引擎 env 旁路**——`CHRONO_BROWSER_PATH`（cdp 浏览器可执行文件探测回退）与 `CHRONO_BROWSER_ENGINE_MODULE`
  （指向导出 `createEngine(config)` 的外部引擎模块，供引擎扩展 / 测试注入；模块住包外、不入世界）是两条环境变量旁路，
  属运行期配置 / 测试注入点，不是写通道。

## 截图与资产

- 截图字节**不进 args / 结果**，走 `{kind:'asset', sha256, mime, size}` 引用，**经 `host.asset.put`（S1 已落地；本插件 pin host）**（2026-09-20 修订）。
  > **宿主能力（S1 已落地）**：插件服务存 / 取资产字节（反向可调用的 `host.asset.put` / `host.asset.get`）。`binary_unsupported` 现用于资产体积超限（`asset_too_large` 归一）与分块后置场景（2026-09-20 修订）。

## 错误码

| 码 | 触发 |
| --- | --- |
| `session_not_found` | 会话 id 未知 / 已回收 / 跨换代失效 / **浏览器进程崩溃致会话失效**（**可选重建；同一 URL 状态不可恢复，登记**）（2026-09-20 修订） |
| `navigate_failed` / `http_status` | 导航失败 / 4xx-5xx |
| `element_not_found` | 选择器未命中 / 超时 |
| `net_denied` | `caps.net` 未授权 / 档位拒绝（#25） |
| `browser_unsupported` | 引擎 / 平台不可用 |
| `binary_unsupported` | 资产体积超限（`host.asset.put` 的 `asset_too_large` 归一到此）/ 分块等后置场景（截图经 `host.asset.put` 走资产面，S1 已落地）（2026-09-20 修订） |
| `tool_timeout` | 超 #25 / 宿主调用超时（原样透传）；`wait_for` 的 `ms` 超单动作超时 |

- **对外失败码是闭集**（与 `schema/tool-browser.json` 的 `invoke_result.error.code` 一致）：资产面等外部码在边界归一——`asset_too_large` → `binary_unsupported`，其余未知码 → `tool_failed`，已知码原样透传。

## 跨插件登记

- **#25 sandbox**：`->` 25，**`caps.net` 声明级钳制 + 资源上限**；浏览器进程由本插件自管 spawn、不经 #25 `exec`（保留例外，同 #37 模式）（2026-09-20 修订）。
  - sandbox **无独立「查 net」方法**（`capabilities` 只自述强制面），net 判定在本插件内；`bag.grant` 对本插件不适用（不经 `exec`，无法放宽 net），不消费、不透传。
- **#27 tools**：按工具类 `tool-browser` 被派发；无执行根需求（**下载落资产面、不落工作区**）（2026-09-20 修订）。
- **#30 tool-http**：分工 = 有会话 / JS 渲染（本插件 `webbrowser`）vs 无状态抓取（`webfetch`）；不互相调用。
- **总表 §1.7 更正（已同步）**：`#31` 依赖原写 `-> 24、25`，v1 不解析密钥，故 pins 只 `-> 25`；总表该行已同步为 `-> 25`。
- **宿主能力**：服务侧资产存取面（截图 / 下载前置，**本插件 pin host**，S1 已落地）；插件 ③ 目录（会话 / 截图暂存，H4 已落地）（2026-09-20 修订）。
