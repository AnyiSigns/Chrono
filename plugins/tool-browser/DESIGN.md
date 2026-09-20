# #31 `tool-browser`（浏览器自动化）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 31 / `tool-browser` |
| 职责 | 浏览器自动化，一个工具 `webbrowser`：**会话化**导航 / 元素交互 / 文本抽取 / 截图；会话状态住宿主侧 ③（进程内），不进世界 |
| 依赖 | `->` 25（pins：隔离执行，浏览器进程起在 #25 内）；`<-` 27（pins：按工具类 `tool-browser` 派发） |
| 成员 | execute, schema（无 terms：服务经**反向帧 `port.call`** 调 #25，`docs/protocol.md` §2.4） |
| 能力类·方法 | `implements: ["tool-browser"]`，`methods: {"tool-browser":["describe","invoke"]}`（**类名 = 身份名**；`describe` 回工具名 `webbrowser`，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | 无 |
| schema | `schema/tool-browser.json`（引擎 `impl` / 无头 / 视口 / 超时 / 会话空闲回收 TTL / 截图格式 / 是否允许下载；可热改） |
| 机制 | 见下「`webbrowser` / 会话 / 隔离」 |
| 边界 | 不做：绕过 guard / sandbox / **无状态抓取（归 30 `webfetch`）** / 工具语义判定（归 26）/ 派发（归 27）/ 写世界（截图走资产引用，见下） |
| 验收 | 1) 同一会话内 `navigate` → `click` → `extract` 保持页面状态；2) `close` 后无残留进程 / 句柄；3) 会话空闲超 TTL 自动回收；4) 与 30 职责不重叠（有会话 = 本插件，无状态 = 30）；5) `caps.net` 被 #25 钳制、越界 `net_denied`；6) 换引擎（Playwright ↔ CDP）不改 #27 / 模型侧 |
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
- `caps` 用 **`{fs:{read,write}, net}` 对象形**（D11；与 #25 一致）：`caps.net = true`；`caps.fs = {read:"none", write:"none"}`（截图不落工作区，走资产引用）。

## 渲染（`describe.render`，本轮定）

```jsonc
{ "form": "card", "label": "webbrowser",
  "summary": "{action}  {url|selector}",        // 折叠态：动作 + 目标（缺项留空）
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

- **会话状态住宿主侧 ③**（本服务进程内 + 必要时 `state/plugins/tool-browser/`），**不进世界、不参与哈希**；服务重启 / 代码换代 ⇒ 旧会话失效（会话不跨换代）。
- **生命周期**：`open` 起 → 空闲超 `TTL` 自动回收 / `close` 显式关 / 服务退出时全关（进程随宿主断连自退出，`docs/protocol.md` §2.7）；不泄漏浏览器进程。
- 会话 id 由服务分配（**确定性**：由 `run` + 序号派生，不用随机，保可回放；`at` 由 bag 传入）。

## 隔离

- 浏览器进程起在 **#25 的隔离环境内**（本插件经**反向帧 `port.call`** 调 #25）；`caps.net` 由 #25 按档与实现能力尽力强制，越界 → `net_denied`。
- 引擎 `impl` 住 schema（`playwright`：自带 Chromium / `cdp`：连系统浏览器）；换引擎不改 #27 与模型侧（工具名 / args 不变）。
- 平台 / 运行时不可用 → `browser_unsupported`（明确失败，不静默降级）。

## 截图与资产

- 截图字节**不进 args / 结果**，走 `{kind:'asset', sha256, mime, size}` 引用。
  > **宿主待补能力（登记）**：插件服务存 / 取资产字节（反向可调用的 `asset` 端口）——v1 入站面只有 `asset.put` / `asset.get`（发起者 → 宿主），服务侧够不着。截图待此面就位；在此之前 `screenshot` 返回 `binary_unsupported`。

## 错误码

| 码 | 触发 |
| --- | --- |
| `session_not_found` | 会话 id 未知 / 已回收 / 跨换代失效 |
| `navigate_failed` / `http_status` | 导航失败 / 4xx-5xx |
| `element_not_found` | 选择器未命中 / 超时 |
| `net_denied` | `caps.net` 未授权 / 档位拒绝（#25） |
| `browser_unsupported` | 引擎 / 平台不可用 |
| `binary_unsupported` | 截图（资产面未就位） |
| `tool_timeout` | 超 #25 / 宿主调用超时（原样透传） |

## 跨插件登记

- **#25 sandbox**：`->` 25，浏览器进程起在其隔离内、`caps.net` 由它钳制（反向帧 `port.call`）。
- **#27 tools**：按工具类 `tool-browser` 被派发；无执行根需求（不下载到工作区）。
- **#30 tool-http**：分工 = 有会话 / JS 渲染（本插件 `webbrowser`）vs 无状态抓取（`webfetch`）；不互相调用。
- **总表 §1.7 更正（已同步）**：`#31` 依赖原写 `-> 24、25`，v1 不解析密钥，故 pins 只 `-> 25`；总表该行已同步为 `-> 25`。
- **宿主待补能力**：服务侧资产存取面（截图前置）；插件 ③ 目录（会话 / 截图暂存）。
