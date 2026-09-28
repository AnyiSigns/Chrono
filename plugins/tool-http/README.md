# tool-http（联网检索与抓取）

联网工具提供者，暴露两个工具：

- `websearch`：在多个**免费源**上并行检索，归一化 → URL 规范化去重 → RRF 合并排序；`read>0` 时**继续抓取前 N 条结果的正文**，一次调用拿到带出处的资料。
- `webfetch`：抓取单个 URL，HTML 转 markdown / 纯文本，二进制存为资产引用。

原先的 `webresearch` 已并入 `websearch`（就是 `websearch` 加 `read>0`）：两者同源清单 / 去重 / RRF，仅差「是否再抓正文」，
合并省掉一份 description / schema。旧名 `webresearch` 仍被 `invoke` 接受（内部调用方与既有测试直达），目录里只广告 `websearch`。

完全**零配置**：不接任何需要 API key / 账号 / 环境变量的源，不 pin 密钥面。网络出口统一经
隔离执行（`sandbox.exec`）跑 fetcher 命令，`caps.net` 由隔离执行按档钳制，越档回 `net_denied`。

- 能力类：`tool-http`；方法：`describe` / `invoke`。
- `pins`：`sandbox`（网络出口与钳制）、`host`（二进制资产存取）。
- 命令：无。状态档：`recomputable`。服务不读投影、不取时间 / 随机、不写世界。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `tool-http.invoke` 130000，避免多源检索被宿主 30s 缺省截断；
  describe 的工具声明 `caps.timeout_ms` 同取 130000，使调用方（tools 按 `caps.timeout_ms + 10s` 推）的反向等待
  严格大于宿主方法级超时；插件内反向等待与传给 sandbox 的 `caps.timeout_ms` 同源（取抓取超时与 caps 的较大者），
  并 clamp 在宿主预算内（`host > reverse > exec`）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## `websearch`

```
websearch(args = { query, count?, sources?, read?, max_chars? })
  read 缺省 0（只检索，等价旧 websearch）
  -> { results:[{title,url,snippet,source,rank}], sources_used:[…], sources_failed:[…] }
  read > 0（等价旧 webresearch）
  -> { query, results:[{title,url,snippet,source,rank,read,content_type?,status?,content?,truncated?,error?}],
       sources_used, sources_failed, read_used, read_failed }
```

- 免费源清单住配置（schema defaults / 数据世代 body），内置：`Bing RSS`（走 `format=rss`，比抓结果页稳定）、`Mojeek`。
  全部免注册 / 免 key / 零配置；源可带 `headers`（如公开 key）与 `extra_query`（固定参数）。
  内建清单只保留实测可达的源；DDG / Wikipedia / SearXNG / Marginalia 在部分网络被污染或限流，已移出内建清单，
  需要时经数据世代 body 加回（配置是数据，不改代码）。
- 流程：并行查各源 → 归一化 → URL 规范化去重 → RRF 合并（分数 = Σ 1/(k + 名次)，k 住配置，
  缺省 60；同分按 URL 升序）→ 取 `top_n`（缺省 10）。多实例源（SearXNG）的实例 / 格式也并发尝试，
  按声明顺序取首个非空，单实例慢不再串行叠加。
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

## `websearch`（`read>0`：检索 + 正文抽取）

```
websearch(args = { query, count?, sources?, read?, max_chars? })   // read > 0
  -> { results:[{title,url,snippet,source,rank,read,content_type?,status?,content?,truncated?,error?}],
       sources_used, sources_failed, read_used, read_failed }
```

- 先按 `websearch` 口径取回候选（同源清单 / 去重 / RRF），再对**名次前 `read` 条**并行抓正文：
  HTML → 正文提取 + markdown；`json` / `text/*` / `+xml` 原样；二进制记 `binary_unsupported` 不落内容。
- `read` 缺省 0、上限 5；`read>0` 时对**名次前 `read` 条**并行抓正文，`0` = 只检索不读正文（等价无 `read`）；
  旧 `webresearch` 的缺省 3 已改为 0（要正文需显式给 `read`）；`max_chars` 缺省 4000、范围 200–20000，
  超限按字符截断并标记该条 `truncated`。
- **正文抓取的失败按条隔离**：单页 `bad_url` / `robots_disallowed` / `net_denied` / `http_status` /
  `binary_unsupported` / `fetch_failed` 只在该条上标 `read:false` + `error.code`，其余照回；
  检索阶段全源失败才整体回 `all_sources_failed`。
- 与 `webfetch` 同口径：`block_private_hosts` 对每个 URL 生效，`obey_robots` 对正文页生效；正文走隔离执行 `net=all`。

## 结果摘要（digest）

成功结果的 `result` 自带 `digest`（普通对象），供上下文老化直接渲染，装配器无需认识本工具语义；
不替换任何原有字段，与完整结果并存，模型仍可据句柄 / 参数重取。确定、有界、不含时间与正文全文：

| 工具 | digest |
| --- | --- |
| `webfetch` | `{ url, status, bytes }`（`bytes` = 返回正文字节数；二进制为资产体积） |
| `websearch`（`read=0`） | `{ query, hits, sources }` |
| `websearch`（`read>0`） | `{ query, hits, sources }` |

## 配置

配置是数据：**本身份数据世代 body 优先**（调用方随 invoke bag 的 `config` 传入），
缺省回落本包 `schema/tool-http.json` 的 `defaults`，再回落内建兜底。热改 = 数据换代，进程不动。

| 键 | 含义 |
| --- | --- |
| `sources` | 免费源清单（id / name / kind / parse / enabled / endpoint / instances / query_param / extra_query / headers / timeout_ms / language） |
| `top_n` | `websearch` 结果条数上限（缺省 10） |
| `rrf_k` | RRF 融合常数（缺省 60） |
| `output_max` | 响应体大小上限（缺省 1 MiB） |
| `user_agent` | 抓取 User-Agent（不伪装） |
| `obey_robots` | 是否遵循 `robots.txt`（**缺省关**） |
| `redirect_max` | 重定向上限 |
| `block_private_hosts` | 是否拒绝内网地址 |
| `fetcher_cmd` | 外部 fetcher 命令名；缺省空 = 用本包内置 Node fetcher |
| `fetcher_env` | 传给 fetcher 子进程的环境变量（隔离执行 `env_clear` 后注入）；走代理时设 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`/`HTTP_PROXY` |
| `source_timeout_ms` | 单源抓取超时缺省 |

网络出口被 DNS 污染 / IP 封锁时，抓取会连不上（`fetch_failed`）。内置 fetcher 用 Node `fetch`，
它**默认不读** `HTTPS_PROXY`；经 `fetcher_env` 注入 `NODE_USE_ENV_PROXY=1` + 代理地址后才会走代理
（隔离执行会清空子进程环境，故代理只能经此注入，不继承系统代理）。

`obey_robots` 缺省关：免费检索源的 `robots.txt` 普遍 `Disallow: /search`（Bing / Mojeek 皆然），
开则 `websearch` 恒 `all_sources_failed`。工具按「用户主动发起的浏览器式抓取」处理（UA 不伪装）；
确需礼貌抓取时经数据世代 body 置 `true`。

## fetcher 命令契约

本插件把抓取意图映射为参数，经隔离执行跑 fetcher。**缺省用本包内置的 Node fetcher**（`execute/fetcher-cli.mjs`，
用当前 Node 可执行文件跑，零运行前置）；配置 `fetcher_cmd` 非空时改用该外部命令（如沙箱镜像提供）：

```
fetcher --url <url> --method <GET|POST> [--header k:v …] --timeout <ms> --max-size <bytes>
        --max-redirs <n> --meta
  -> stdout: 首行元数据 JSON {"status","content_type","url","truncated","body_encoding":"base64"}
             其余为 base64 响应体
  -> stderr: 错误文本；退出码非 0 表示传输失败
```

响应体 base64 化以便二进制安全穿越协议帧；`--meta` 是本插件与 fetcher 的约定。本插件不自开网络旁路。

- **大小与截断**：`--max-size` 取 `output_max`；传给隔离执行的 stdout 上限已按 base64 膨胀（4/3）加余量放大，不会因编码膨胀而截断。仍合并 exec 的 `truncated` 作兜底——文本截断标记 `truncated`，**二进制一旦截断回 `too_large`、不存资产**。
- **运行前置**：缺省内置 fetcher 只依赖 Node 自身，**无镜像 / 无外部命令前置**；配置了外部 `fetcher_cmd` 时才要求该命令存在（沙箱镜像缺命令 → `fetch_failed`）。沙箱前置失败（exec 未起）原样透传 `sandbox_setup_failed`。测试与 E2E 用可注入的假后端覆盖映射与分流逻辑，不真实触网；内置 fetcher 另有本地 http 契约测试。

## 错误码

| 码 | 触发 |
| --- | --- |
| `bad_args` | args 形态非法 |
| `unknown_tool` | `tool` 不是 `websearch` / `webfetch`（`webresearch` 作为旧名仍接受） |
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
