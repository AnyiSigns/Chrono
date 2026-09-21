# tool-http（联网检索与抓取）

联网工具提供者，暴露两个工具：

- `websearch`：在多个**免费源**上并行检索，归一化 → URL 规范化去重 → RRF 合并排序。
- `webfetch`：抓取单个 URL，HTML 转 markdown / 纯文本，二进制存为资产引用。

完全**零配置**：不接任何需要 API key / 账号 / 环境变量的源，不 pin 密钥面。网络出口统一经
隔离执行（`sandbox.exec`）跑 fetcher 命令，`caps.net` 由隔离执行按档钳制，越档回 `net_denied`。

- 能力类：`tool-http`；方法：`describe` / `invoke`。
- `pins`：`sandbox`（网络出口与钳制）、`host`（二进制资产存取）。
- 命令：无。状态档：`recomputable`。服务不读投影、不取时间 / 随机、不写世界。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `tool-http.invoke` 120000，避免多源检索被宿主 30s 缺省截断。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## `websearch`

```
websearch(args = { query, count?, sources?, fresh? })
  -> { results:[{title,url,snippet,source,rank}], sources_used:[…], sources_failed:[…] }
```

- 免费源清单住配置（schema defaults / 数据世代 body），内置：`DuckDuckGo HTML`、`DuckDuckGo Lite`、
  `Bing`、`Mojeek`、`SearXNG`（可配多实例，优先 `format=json`、被禁退 HTML）、`Wikipedia API`。
- 流程：并行查各源 → 归一化 → URL 规范化去重 → RRF 合并（分数 = Σ 1/(k + 名次)，k 住配置，
  缺省 60；同分按 URL 升序）→ 取 `top_n`（缺省 10）。
- **部分失败不整体失败**：可用源结果照回，失败源记入 `sources_failed`；全部源失败才回 `all_sources_failed`。
- 单源超时 / 非 2xx / 结构变化只记失败，不重试成风暴；实例清单可热改。

## `webfetch`

```
webfetch(args = { url, format? })   // format = "markdown"（缺省）| "text" | "raw"
  -> { url, status, content_type, content, truncated, asset? }
```

- GET → 跟随重定向（上限住配置）→ 按 `content-type` 分流：
  `text/html` → 正文提取 + 转 markdown（`format:"raw"` 原样、`"text"` 纯文本）；
  `application/json` / `text/*` / `+xml` → 原样；其它二进制 → `host.asset.put` 存资产、回资产引用。
- 文本响应体 ≤ `output_max`，超限截断并标记 `truncated`；二进制超限或被截断回 `too_large`（不存资产）。
- `bad_url`：形态非法 / 非 http(s) / 内网地址（按配置 `block_private_hosts`）。

## 配置

配置是数据：**本身份数据世代 body 优先**（调用方随 invoke bag 的 `config` 传入），
缺省回落本包 `schema/tool-http.json` 的 `defaults`，再回落内建兜底。热改 = 数据换代，进程不动。

| 键 | 含义 |
| --- | --- |
| `sources` | 免费源清单（id / name / kind / parse / enabled / endpoint / instances / query_param / timeout_ms / language） |
| `top_n` | `websearch` 结果条数上限（缺省 10） |
| `rrf_k` | RRF 融合常数（缺省 60） |
| `output_max` | 响应体大小上限（缺省 1 MiB） |
| `user_agent` | 抓取 User-Agent（不伪装） |
| `obey_robots` | 是否遵循 `robots.txt`（缺省开） |
| `redirect_max` | 重定向上限 |
| `block_private_hosts` | 是否拒绝内网地址 |
| `fetcher_cmd` | fetcher 命令名（缺省 `fetcher`） |
| `source_timeout_ms` | 单源抓取超时缺省 |

## fetcher 命令契约

本插件把抓取意图映射为参数，经隔离执行跑沙箱镜像内的 fetcher：

```
fetcher --url <url> --method <GET|POST> [--header k:v …] --timeout <ms> --max-size <bytes>
        --max-redirs <n> --meta
  -> stdout: 首行元数据 JSON {"status","content_type","url","truncated","body_encoding":"base64"}
             其余为 base64 响应体
  -> stderr: 错误文本；退出码非 0 表示传输失败
```

响应体 base64 化以便二进制安全穿越协议帧；`--meta` 是本插件与 fetcher 的约定。本插件不自开网络旁路。

- **大小与截断**：`--max-size` 取 `output_max`；base64 膨胀后 stdout 可能被隔离执行的 `output_max` 再截断，故本插件合并 exec 的 `truncated`——文本截断标记 `truncated`，**二进制一旦截断回 `too_large`、不存资产**。
- **运行前置（写死）**：`fetcher` 由沙箱镜像提供（curl 类工具）；本插件的「零配置」只承诺**零 API key / 账号 / 环境变量**，**不承诺零运行前置**。镜像缺该命令 → `fetch_failed`；沙箱前置失败（exec 未起）原样透传 `sandbox_setup_failed`。测试与 E2E 用可注入的假后端覆盖映射与分流逻辑，不真实触网。

## 错误码

| 码 | 触发 |
| --- | --- |
| `bad_args` | args 形态非法 |
| `unknown_tool` | `tool` 不是 `websearch` / `webfetch` |
| `bad_url` | URL 形态非法 / 非 http(s) / 内网地址（按配置）；含重定向后落到内网的最终 URL |
| `net_denied` | `caps.net` 未授权 / 档位拒绝（隔离执行原样透传） |
| `fetch_failed` | DNS / 连接 / TLS 失败，或 fetcher 输出不合法；沙箱超限被杀 `oom` / `cpu_exceeded` / `procs_max` / `output_max` 归一到此码 |
| `sandbox_setup_failed` | 沙箱前置失败（exec 未起）——原样透传 |
| `http_status` | 4xx / 5xx（附 status） |
| `too_large` | 二进制响应体超上限或被截断 |
| `binary_unsupported` | 资产存取不可用 / 失败 |
| `robots_disallowed` | `robots.txt` 禁止抓取该路径（含重定向后的最终 URL） |
| `all_sources_failed` | `websearch` 全部选中源失败 |
| `tool_timeout` | 反向调用 / 宿主调用超时 |
| `tool_failed` | `invoke` 顶层兜底：未归类异常转结构化错误 |

## 边界

- 不做有会话 / 执行 JS 渲染（归浏览器工具）；不做工具语义判定（归语义门）；不做派发（归工具注册）。
- 不写世界：只回结果，二进制经资产面回引用。
- 不 import 宿主 / 内核 / 其他插件包；运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test                                  # 协议级 + 纯函数测试（node --test，假后端，离线）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack → seed → start → loaded → 直连服务 → stop → verify/replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`）随源码入世。
