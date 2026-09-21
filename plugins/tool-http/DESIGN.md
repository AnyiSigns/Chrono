# #30 `tool-http`（联网检索与抓取）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 30 / `tool-http` |
| 职责 | 联网检索与抓取，两个工具：`websearch`（**多个免费源**并行检索 + 去重合并排序）、`webfetch`（抓一个 URL → markdown / text） |
| 依赖 | `->` 25（pins：隔离执行 + `caps.net` 强制）；`<-` 27（pins：按工具类 `tool-http` 派发） |
| 成员 | execute, schema（无 terms：服务经**反向帧 `port.call`** 调 #25，`docs/protocol.md` §2.4） |
| 能力类·方法 | `implements: ["tool-http"]`，`methods: {"tool-http":["describe","invoke"]}`（**类名 = 身份名**；`describe` 回工具名 `websearch` / `webfetch`，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | 无 |
| schema | `schema/tool-http.json`（免费源清单与开关 / 每源超时 / 结果条数 / 响应大小上限 / User-Agent / 是否遵循 `robots.txt`；可热改；顶层 `method_timeouts` 声明 `tool-http.invoke` 120000——宿主按声明覆盖 30s 缺省） |
| 机制 | 见下「`websearch` / `webfetch` / 网络与隔离」 |
| 边界 | 不做：绕过 guard / sandbox / **有会话 / 执行 JS 渲染（归 31 `webbrowser`）** / 工具语义判定（归 26）/ 派发（归 27）/ 写世界（只回结果）/ **接入任何需 API key 或账号的搜索源**（与「零配置」冲突，见下） |
| 验收 | 1) `websearch` 至少两源可用、结果去重合并且确定排序；2) 单源失败不整体失败（返回可用结果 + 标记失败源）；3) 全源失败才 `all_sources_failed`；4) `webfetch` 的 HTML 正文提取与 markdown 转换确定；5) `caps.net` 被 #25 按档钳制，越界 `net_denied`；6) **零 API key / 账号 / 环境变量**可跑：不接任何需 key / 账号 / 环境变量的源（**不承诺零运行前置**——fetcher 由沙箱镜像提供，见「fetcher 命令契约」）；7) 明文密钥不出现在 args / 结果 / 审计；8) 换源清单不改代码 |
| 状态 | 细节设计（2026-09-19）：按 `tool` 端口契约展开；工具集按用户口径定为 `websearch` / `webfetch`；**联网检索为「完全免费 + 零配置」**（无 API key、无账号、无环境变量）；**pins 更正**：因此不含 `24`（见「跨插件登记」） |

## `websearch`

```
websearch(bag.args = { query, count?, sources?, fresh? })
  -> { results:[{title,url,snippet,source,rank}], sources_used:[…], sources_failed:[…] }
```

- **免费源**（v1：**零配置** —— 无 API key、无账号、无环境变量；清单住 schema、可开关 / 可加）：

  | 源 | 端点 | 取法 |
  | --- | --- | --- |
  | `DuckDuckGo HTML` | `html.duckduckgo.com/html/` | HTML 解析 |
  | `DuckDuckGo Lite` | `lite.duckduckgo.com/lite/` | HTML 解析（轻、备用） |
  | `Bing` | `www.bing.com/search` | HTML 解析 |
  | `Mojeek` | `www.mojeek.com/search` | HTML 解析（对抓取友好） |
  | `SearXNG` 公共实例 | 可配多个实例 | 优先 `format=json`，被禁则退 HTML 解析 |
  | `Wikipedia API` | `*.wikipedia.org/w/api.php` | 公开 JSON（百科类补充） |

- **零配置红线（写死）**：**不引入任何需要 key / 账号 / 环境变量的源**（Brave Search API、Google CSE、Bing Web Search API、SerpAPI 等一律不接）；因此本插件**不 pin `#24 secrets`**。加源只改 schema 清单，不改代码。
- **抓取礼貌策略（2026-09-20 修订）**：`robots.txt` / User-Agent 覆盖**搜索源 HTML 抓取**（与 `webfetch` 同规）——不伪装、遵守站点声明；搜索源若禁抓则记入 `sources_failed`。
- **流程**：并行查各源 → 归一化 `{title,url,snippet,source,rank}` → **URL 规范化去重** → **RRF 合并排序**（各源 rank 倒数融合，确定、可回放）→ `top_n`（缺省 10）。
- **部分失败不整体失败**：可用源结果照回，失败源记入 `sources_failed`；全失败 → `all_sources_failed`。
- **抗限流**：单源超时 / 429 / 结构变化都只记入 `sources_failed`，不重试成风暴；实例清单可热改（坏实例随时换）。

## `webfetch`

```
webfetch(bag.args = { url, format? })   // format = "markdown"（缺省）| "text" | "raw"
  -> { url, status, content_type, content, truncated }
```

- **流程**：GET → 跟随重定向（上限住 schema）→ 按 `content-type` 分流：
  `text/html` → 正文提取 + 转 markdown（`format:"raw"` 则原样）；`application/json` / `text/*` → 原样；
  其它二进制 → 经 **`host.asset.put` 存资产、引用进结果**（**本插件 pin host**，S1 已落地）；分块等后置场景保留 `binary_unsupported`（2026-09-20 修订）。
- 文本响应体 ≤ `output_max`，超限（含被 #25 截断）截断并标记 `truncated`；二进制超限或被截断回 `too_large`（不存资产）；`robots.txt` 遵循与否住 schema。

## fetcher 命令契约（2026-09-20 修订）

`websearch` / `webfetch` 的网络出口统一经 **#25 `exec` 跑 fetcher 命令**（fetcher = 沙箱镜像内 `curl` 类工具）：

```
fetcher --url <url> --method <GET|POST> [--header k:v …] --timeout <ms> --max-size <bytes>
        --max-redirs <n> --meta
  -> stdout: 首行元数据 JSON {"status","content_type","url","truncated","body_encoding":"base64"}
             其余为 base64 响应体
  -> stderr: 错误文本；退出码非 0 表示传输失败
```

- 响应体 **base64 化**（≈1.33×）以便二进制安全穿越协议帧；`--meta` 是本插件与 fetcher 的约定（**实现口径**：首行元数据 + base64 体，不是「裸响应体」）。
- 本插件把工具 args（URL / method / headers / 超时 / 大小上限 / 重定向上限）映射为上述参数；`#25` 按 `caps.net` 四档钳制（`none` / `limited`（声明 hosts 白名单）/ `all`），越档 `net_denied`（错误码已登记 `protocol.md` §四）。
- **大小与截断（写死）**：`--max-size` 取 `output_max`，但 base64 膨胀后 stdout 会被 #25 的 `output_max` 再截断；故 `fetchUrl` **必须合并 #25 exec 的 `truncated`**（fetcher 元数据的 `truncated` 只反映自身 `--max-size`）。文本超限截断并标记 `truncated`；**二进制一旦截断显式回 `too_large`、不存资产**（否则会存下被截断的字节）。
- 二进制响应经 `host.asset.put` 存资产、引用进结果（本插件 pin host）。
- **运行前置（写死）**：fetcher 由**沙箱镜像提供**（本插件不自带、不 pin 具体实现）；镜像缺该命令时 exec 非 0 / 输出缺元数据 → `fetch_failed`，沙箱前置失败（exec 未起）原样透传 `sandbox_setup_failed`。本插件的「零配置」只承诺**零 API key / 账号 / 环境变量**，不承诺零运行前置。

## 渲染（`describe.render`，本轮定）

| 工具 | `form` | `label` | `summary` | `tone` | `detail` |
| --- | --- | --- | --- | --- | --- |
| `websearch` | `card` | `websearch` | `{query}` | `ghost` | `{kind:"list", fields:["title","url","snippet","source"]}`（多源合并后的结果列表） |
| `webfetch` | `card` | `webfetch` | `{url}` | `ghost` | `{kind:"code", lang:"markdown"}`（正文 / 原样内容） |

- 两者都用**近乎透明卡片**（`tone:"ghost"`，与 #28 的 `grep` / `glob` 同质感）：默认收缩显示查询 / URL，展开显示结果。
- 无动态输出（`live:false`）：联网结果一次返回；部分源失败在展开态的列表尾部标 `sources_failed`。

## 网络与隔离

- **网络出口经 #25 `exec` 跑 fetcher 命令（2026-09-20 修订）**：命令契约 = URL / method / headers / 超时 / 大小上限 → fetcher 参数映射（fetcher = 沙箱镜像内 `curl` 类工具，见上「fetcher 命令契约」）；#25 按 **`caps.net` 四档钳制**、越档 `net_denied`（错误码已登记 `protocol.md` §四）。
- 每个操作 = 一次**反向帧 `port.call`** 到 #25 执行；本插件不自开网络旁路、不绕 #25。
- 无 cookie / 无页面状态，每次调用独立；`websearch` / `webfetch` 都 `idempotent:true`（GET 类）⇒ 宿主按 `(port, method, canonicalJson(args))` 缓存，摊平单 directive 内重复触碰。**已知取舍**：缓存键只含 args、不含时间，故同一 run 内重复同参调用回同结果（可回放优先）；**GET 类缓存跨 run 不复用**（同 run 内新鲜度取舍已知）（2026-09-20 修订）。

## 错误码

| 码 | 触发 |
| --- | --- |
| `bad_args` | args 形态非法（query / url 缺失或类型不符） |
| `bad_url` | URL 形态非法 / 非 http(s) / 内网地址（按 schema 策略）；含**重定向后落到内网**的最终 URL |
| `unknown_tool` | `invoke` 的 `tool` 不是 `websearch` / `webfetch` |
| `net_denied` | `caps.net` 未授权 / 档位拒绝（#25 原样透传） |
| `fetch_failed` | DNS / 连接 / TLS 失败；fetcher 非零退出 / 输出缺元数据 / base64 非法；**沙箱 exec 被超限杀时 `oom` / `cpu_exceeded` / `procs_max` / `output_max` 归一到此码** |
| `sandbox_setup_failed` | 沙箱前置失败（exec 未起）——**原样透传**，不归一 |
| `http_status` | 4xx / 5xx（附 status，非传输错） |
| `too_large` | 二进制响应超上限**或被截断**（不存资产） |
| `binary_unsupported` | 资产存取不可用 / 失败（`host.asset.put` 失败） |
| `robots_disallowed` | `robots.txt` 禁止抓取该路径（含跟随重定向后的最终 URL） |
| `all_sources_failed` | `websearch` 全源失败（附 `sources_failed`） |
| `tool_timeout` | 沙箱 `timeout` / 反向调用 / 宿主调用超时（原样透传） |
| `tool_failed` | `invoke` 顶层兜底：未归类的异常转结构化错误（不炸本轮） |

## 跨插件登记

- **#25 sandbox**：`->` 25，联网经其隔离执行、`caps.net` 由它钳制（反向帧 `port.call`）。
- **#27 tools**：按工具类 `tool-http` 被派发；本插件无执行根需求（不用 `bag.workspace_root`）。
- **#31 tool-browser**：分工 = 无状态抓取（本插件）vs 有会话 / JS 渲染（`webbrowser`）；两者不互相调用。
- **总表 §1.7 更正（已同步）**：`#30` 依赖原写 `-> 24、25`，但**本插件零配置**（无 API key / 账号 / 环境变量），不解析密钥，故 pins 只 `-> 25`；总表该行已同步为 `-> 25`。
- **不接需密钥的源（红线）**：Brave Search API / Google CSE / Bing Web Search API / SerpAPI 等一律不接；若将来要接，须先改本条红线并重新登记 `-> 24`。
- **宿主能力（S1 已落地）**：服务侧资产存取面（二进制响应体前置；`host.asset.put/get`）。**本插件 pin host**：二进制响应经 `host.asset.put` 存资产、引用进结果（2026-09-20 修订）。
