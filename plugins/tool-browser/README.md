# tool-browser（浏览器自动化）

浏览器自动化服务（TypeScript）：一个工具 `webbrowser`，用 `action` 分档做**会话化**导航 / 元素交互 /
文本抽取 / 截图。会话状态住宿主侧 ③（进程内），不进世界、不参与哈希；浏览器进程由本插件直接 spawn 自管。

- 能力类：`tool-browser`；方法：`describe` / `invoke`（类名 = 身份名）。
- `pins`：`{"sandbox":"sandbox","host":"host"}`——`caps.net` 声明级钳制咨询 `sandbox.capabilities`；
  截图字节经 `host.asset.put` 存资产。**浏览器进程本插件自管，不经 `sandbox.exec`。**
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF / 管道断开即自退出并关闭全部会话）。
- 停机：`SIGTERM` / `SIGINT` 走优雅停机（关闭全部会话后退出）；`process.on('exit')` 同步 `killAllSync` 兜底，
  硬杀残留浏览器子进程——**含建引擎途中尚未入册的在途引擎**（工厂在 spawn 后把可同步终止的句柄登记进
  建引擎句柄，`killAllSync` 直接触达，不泄漏进程）。
- 状态档：`recomputable`（会话表住进程内，可重算；不落世界）。
- 无命令面、无 `terms/`；运行时零 npm 依赖。

## `webbrowser`

| `action` | args（要点） | 结果 |
| --- | --- | --- |
| `open` | `viewport?` | `{session}` |
| `navigate` | `session` / `url` / `wait_until?` | `{status, url, title}` |
| `click` | `session` / `selector` | `{ok}` |
| `type` | `session` / `selector` / `text` / `submit?` | `{ok}` |
| `press` | `session` / `key` | `{ok}` |
| `wait_for` | `session` / `selector?` / `ms?` | `{ok}` |
| `extract` | `session` / `selector?` / `attr?` | `{text}` / `{value}` |
| `screenshot` | `session` / `full_page?` / `format?` | `{asset:{kind:'asset',sha256,mime,size}}` |
| `close` | `session` | `{closed}` |

- **`idempotent:false`**：有会话 / 有状态，永不缓存、永不 memo（与无状态抓取相对）。
- `navigate` 仅接受 `http(s)`；`file:` / `javascript:` / `ftp:` 等一律 `navigate_failed`。
  只限协议、**不做 host 过滤**（无 host 白名单需求，登记为已知口径）。
- `press` 向当前焦点元素派发**真实按键**（playwright `keyboard.press` / CDP `Input.dispatchKeyEvent`
  keyDown+keyUp），触发浏览器默认行为（如表单提交），不合成 DOM `KeyboardEvent`。
- `wait_for` 的 `ms` 两引擎统一：等满请求毫秒数；`ms` 超单动作超时回 `tool_timeout`（不静默缩短）。
- `caps` 用对象形并含 `fs.read`：`caps.net = "all"`、`caps.fs = {read:"none", write:"none"}`；
  截图与下载都不落工作区，走资产引用，与 `caps.fs` 无冲突。
- `render` 为**静态**描述符 `{form:"card", label:"webbrowser", summary:"{action}  {url}",
  tone:"plain", detail:{kind:"json"}, live:false}`——`webbrowser` 是单个工具，只能声明一个 `detail.kind`，
  故固定通用 `json`，不按 action 变化。

## 会话

- `open` 起会话并返回会话 id；`close` 显式关；空闲超 TTL 自动回收；服务退出 / 断连 / `SIGTERM` / `SIGINT` 全关
  （`exit` 兜底硬杀，不泄漏浏览器进程）。
- 会话 id **确定性**：由帧 `env.run` + 序号派生（`<run>~<n>`），不用随机；`at` 用 `env.now`（不自取时间）。
- 会话不跨换代 / 重启：服务重启或代码换代后旧会话失效（回 `session_not_found`）。
- 会话表住服务进程内（③ 可重算）；浏览器 profile 落宿主注入的本身份 ③ 目录 `CHRONO_PLUGIN_STATE/browser-profiles/`
  （未注入时回落系统临时目录），关闭会话即清理——**不进世界、不参与哈希**。

## 引擎抽象

浏览器引擎抽成可注入接口 `BrowserEngine`（`execute/engine/types.ts`）：生产实现 `playwright` 与 `cdp`，
按身份 schema 的 `engine.impl` **惰性加载**；模块缺失 / 启动失败 / 平台不可用 → **`browser_unsupported`**（明确失败，不静默降级）。

- `playwright`：惰性 `import('playwright')`，用其自带 Chromium；未安装即 `browser_unsupported`（不内置、不假装有浏览器）。
- `cdp`：探测系统浏览器（配置 `engine.browser_path` > 环境变量 `CHRONO_BROWSER_PATH` > 平台候选路径）后 spawn，
  经 CDP（Node 内建全局 `WebSocket`）驱动一个页面；找不到浏览器即 `browser_unsupported`。
- **引擎注入点**：环境变量 `CHRONO_BROWSER_ENGINE_MODULE` 指向一个导出 `createEngine(config, handle)` 的模块时改用它
  （引擎外部扩展 / 测试注入；模块住包外，不入世界）；`handle` 用于登记建引擎途中可同步硬杀的中间态。

引擎只暴露会话内的页面动作面，换引擎不改工具名与 args；`describe` / `invoke` 与模型侧不受影响。

## `caps.net` 声明级钳制

本插件不经 `sandbox.exec`，故 `caps.net` 的声明级钳制在**本插件内**完成（实现尽力）：

- 声明需求 `caps.net` 为字符串，只认 `none` / `limited` / `all`（与 sandbox `tiers.rs` 的 `NetScope::parse`
  同口径；布尔 / 畸形按未声明处理，与 sandbox `parse_caps` 一致）。浏览器可导航任意 host，**需求是 `all`**。
- 按 `bag.tier` + `bag.sandbox_tiers`（身份数据世代 body，缺省回落与 sandbox 内建同形的映射）算当前档的 net 范围；
  `all` 需求下 `severe`(limited) / `review` / `deny` 越档 → `net_denied`；未知 / 缺失档位 fail-closed 全拒。
- 需要联网的动作前，经反向 `port.call` 咨询 `sandbox.capabilities`（强制面可用性），并**消费**其
  `enforcement.net` 自述：自述为 `none`（不强制 net）时 fail-closed 拒绝；自述缺失 / 未知以本插件判定为准。
  该调用返回的错误原样透传。

> **登记**：sandbox **无独立「查 net」方法**（`capabilities` 只自述强制面），真正的 net 判定在本插件内完成。
> **已知取舍**：`limited` 档的 hosts 白名单对浏览器动态导航无法逐 host 强制——`limited` 对动态导航**无 host 语义**，
> 故只做**声明级**钳制（与「实现尽力」口径一致）；真实网络隔离不在本插件内做。
> **`bag.grant` 不适用**：浏览器进程本插件自管、不经 `sandbox.exec`，一次性 grant 无法放宽 net；schema 不声明、运行期不消费、也不透传。

## 截图与资产

- 截图字节**不进 args / 结果**：引擎产出字节后经 `host.asset.put` 存资产，结果只回 `{kind:'asset', sha256, mime, size}` 引用。
- 下载落点同走资产面（不开工作区写入）；v1 是否允许下载由 schema `download.allow` 声明，缺省不允许。

## 错误码

| 码 | 触发 |
| --- | --- |
| `session_not_found` | 会话 id 未知 / 已回收 / 跨换代失效 |
| `navigate_failed` / `http_status` | 导航失败 / 4xx-5xx |
| `element_not_found` | 选择器未命中 / 等待超时 |
| `net_denied` | `caps.net` 越档 / sandbox 档位拒绝（原样透传） |
| `browser_unsupported` | 引擎 / 平台不可用 |
| `binary_unsupported` | 资产体积超限（`host.asset.put` 的 `asset_too_large` 归一到此）/ 分块等后置场景 |
| `tool_timeout` | 超 sandbox / 宿主调用超时（原样透传）；`wait_for` 的 `ms` 超单动作超时 |
| `tool_failed` / `unknown_tool` / `bad_args` | 引擎内部失败 / 工具名不符 / args 形态非法 |

> 对外失败码是**闭集**（与 `schema/tool-browser.json` 的 `invoke_result.error.code` 一致）；
> 资产面等外部码在边界处归一（`asset_too_large` → `binary_unsupported`，其余未知码 → `tool_failed`，已知码原样透传）。

## 运行

```sh
npm test                     # 协议级 + 模块级测试（node --test，注入假引擎与假反向调用通道）
node tools/e2e-smoke.mjs     # 宿主装配 E2E（pack sandbox + tool-browser → seed → start → 直连服务协议 → stop → verify/replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
