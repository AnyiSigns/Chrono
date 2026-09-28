# tool-fs（文件工具）

结构化文件读写服务（**Rust**）：五个工具 `read` / `edit` / `glob` / `grep` / `stat`，路径与范围归类在本插件，
**所有触盘经反向帧 `port.call` 到 `sandbox.fsop`**——本插件不直接触盘、不写世界、不绕过 guard / sandbox。

- 能力类：`tool-fs`；方法：`describe` / `invoke`（类名 = 身份名）。
- 命令：无（`commands: []`）。
- `pins`：`sandbox`（所有触盘经其 `fsop` 隔离 / 四档强制）、`host`（二进制字节通道 `host.asset.put/get` 的 pin 声明）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 实现语言：Rust（源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧依赖缓存）。

## 五个工具

`describe(bag)` 一次回报五个工具（四要素 / `argsSchema` / `caps` / `idempotent` / `render`）：

| 工具 | 幂等 | `caps.fs` | args | 结果 |
| --- | --- | --- | --- | --- |
| `read` | ✗ | read | `path` / `offset?` / `limit?` | `{text, total_lines, start_line, end_line, lines_returned, has_more, next_offset, content_truncated, truncated}` |
| `edit` | ✗ | write | `path` / `old` / `new` / `replace_all?` | `{created?, replaced, bytes_written, added, removed, patch}` |
| `glob` | ✗ | read | `pattern` / `path?` / `ignore?` / `limit?` | `{paths, truncated}` |
| `grep` | ✗ | read | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `before?` / `after?` / `glob?` / `path?` / `ignore?` / `limit?` | `{matches, truncated, skipped}` |
| `stat` | ✗ | read | `path` | `{exists, is_dir, size, mtime}` |

- 文件可变，五个工具都标 `idempotent:false`（不进宿主结果缓存）。
- `stat`：只读单个路径元信息（`exists` / `is_dir` / `size` / `mtime`），供「是否存在 / 是否目录 / 比较新旧」用；
  `mtime` 取自文件系统、不参与确定性保证；**不用于替代 `glob` 的有序遍历**（`glob` 保持路径字典序以保证重放确定）。
- `edit` 两种形态：`old` 非空 ⇒ 精确替换（未唯一命中回 `edit_conflict`，`replace_all:true` 全部替换）；
  `old` 为空 ⇒ 新建：只发一次 `write`，带 `exclusive:true`，文件已存在回 `edit_conflict`、不覆盖。
  行尾不敏感：LF 形态的 `old` 也能改 CRLF 文件（由 sandbox 按文件行尾风格适配）。
- `render`：**收起态给调用输入（args），展开态给工具输出（按 `detail.kind` 定制渲染）**——
  `read` = 近透明卡片（`tone:"ghost"`）+ 展开内容块（`detail:{kind:"code"}`）；`edit` = 默认收缩卡片 +
  `detail:{kind:"diff"}`；`glob` / `grep` = 近透明卡片 + `detail:{kind:"paths"|"matches"}`；`stat` = `detail:{kind:"json"}`。
  `summary` 用可选段 `{? ... }`（段内字段全非空才输出）拼收起态 args，避免缺省参数留下悬空分隔符：
  如 `read` 的 `{path}{?  · offset {offset}}{?  · limit {limit}}`、`edit` 的 `{path}{?  +{result.added} -{result.removed}}`。
  `detail` 只声明渲染器种类，数据由渲染器按 `kind` 从结果取（`{result.*}` 模板只用于 `summary`）。

## 结果摘要（digest）

成功结果的 `result` 自带 `digest`（普通对象，供上下文老化直接渲染、不替换原有字段）：

| 工具 | digest |
| --- | --- |
| `read` | `{ path, lines, sha, summary }`——`lines` 形如 `1-240`；`sha` = 返回窗口文本的 sha256；`summary` 形如 `240 行 / 8.2KB` |
| `glob` | `{ pattern, hits, files }`——`hits` / `files` 同为路径条数 |
| `grep` | `{ pattern, hits, files }`——`files` = 出现过的不同 `path` 数 |

`edit`（改写资源）/ `stat`（单路径元信息）不附 digest。摘要确定、有界，不含时间与正文全文。

## `invoke` 与 fsop 映射

`bag = {tool, args, workspace_root, tier, caps, grant?, ignore?, sandbox_tiers?}`：

| 工具 | fsop op | args |
| --- | --- | --- |
| `read` | `read` | `offset?` / `limit`（缺省 2000） |
| `edit`（`old` 非空） | `replace` | `old` / `new` / `replace_all?` |
| `edit`（`old` 空） | `write` | `data=new` / `create:true` / `exclusive:true` |
| `glob` | `list` | `pattern` / `base=path?` / `ignore` / `limit`（缺省 200） |
| `grep` | `grep` | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `before?` / `after?` / `glob?` / `base=path?` / `ignore` / `limit`（缺省 200） |
| `stat` | `stat` | `path`（`base` 不用） |

- `glob` / `grep` 的 `path?` 映射 `fsop.base`；`ignore` 原样传。
- 忽略表优先级：工具 `args.ignore` > 调用方 `bag.ignore`（身份数据世代 body，经入口装配下传）> 内置兜底
  （`.git` / `node_modules` / `target` / `__pycache__` / `.venv`，与 `schema/tool-fs.json` 一致）。
  **显式空数组表示「不忽略」**；忽略条目按路径段匹配并在遍历时对目录整棵剪枝（`target` 即剪掉整棵 `target/`），
  含 `/` 的条目按相对路径 glob。
- `tier` / `workspace_root` / `grant` / `sandbox_tiers` 原样透传；`caps` 的资源上限沿用调用方声明或 schema 缺省。
- `sandbox` 的错误（`fs_denied` / `edit_conflict` / `binary_unsupported` / `too_large` / `path_not_found` 等）
  **原样透传**（不吞、不改写）；结果面 `{ok:true,result}` / `{ok:false,error:{code,message}}`。

## 路径与范围归类（本插件独有职责）

- 相对路径以 `workspace_root` 为基准；绝对路径（含区外）同样合法；`..` 按词法规范化、不直接判错。
- 形态非法（空串 / NUL / 控制字符 / 平台非法字符 / Windows 保留设备名 / ADS `file:stream` / 尾随点或空格）
  → `bad_path`（机械拒、不触盘，与 sandbox 同口径或更严）。
- 本插件做**词法**归类（区内 / 区外）并据此声明 `caps.fs.*`（区内 `workspace` / 区外 `full`）；
  **realpath 解析、符号链接逃逸判定与强制点唯一在 `sandbox.fsop`**——本插件不直接触盘，归类只是声明。
- 相对路径缺 `workspace_root` → `workspace_missing`；绝对路径不需要 `workspace_root` 仍可派发。
- 区外不由本插件判升级：本插件只声明「区外 + 读 / 写」，是否弹卡归 `guard`；批准后的一次性 `caps.grant`
  由调用方随 bag 传入 → 本插件**透传**给 `sandbox.fsop` 放行本次。

## 大小与二进制

- 文本读写：UTF-8；`read` 默认行窗口（`offset` / `limit`），`text` 为原始文本、不带行号前缀，**保留文件原有行尾**
  （CRLF 不被改写，便于把读到文本直接作为 `edit.old`）。
- `offset` 非整型 / 负值、`limit` 非正整数（0 / 负 / 非整型）→ `bad_args`（不静默夹取）；越界 `offset` 仍合法
  （sandbox 夹到文件尾，空窗口）。
- `read` 结果带窗口元信息：`start_line` / `end_line`（1 基）、`lines_returned`；有后续行时 `has_more:true`，
  用 `next_offset`（0 基，等价下一次 `offset`）续读；`content_truncated:true` 表示内容被 `output_max` 按字节
  截断（末行可能不完整、文件其余不可再读）。`truncated` 保留旧口径（窗口非全文即真）。
- `grep` 的 `mode`（`literal` / `regex`）缺省为 **literal**（不按元字符猜正则）；`mode:"regex"` 时由 sandbox
  校验简易正则支持子集。简易正则不支持交替 `|` / 分组 `()` / 重复 `{…}` / `\d` 等类简写——命中即 `bad_args`，
  不静默按字面匹配。
- `grep` 另可透传 `ignore_case`（Unicode casefold，表驱动、未做 NFC/NFD 规范化）、`files_only`（每文件一条：首命中行号/文本 + `count`，
  用于「哪些文件含 X」省 token）、`before` / `after`（每条命中的上下文行数，0–20，附 `before`/`after` 数组）。
  这些只增字段、不改 `matches` 形状；渲染器按 `count`（>1 时）/ `before` / `after` 展示，缺省不显示。
- `grep` 静默跳过二进制 / 超 `output_max` / 不可读的文件，跳过数量在结果 `skipped:{binary, too_large, unreadable}`
  回报（结果可能因此不完整）；`read` 命中二进制仍回 `binary_unsupported`。
- v1 文本路径完整；命中二进制 → `binary_unsupported`。
- `host.asset.put/get` 是 pin 声明：**契约就位、v1 未启用**（本插件暂无二进制字节通道需求）；后续二进制读写走该通道。

## 已知限制与对齐说明

- **`glob` 顺序**：`sandbox.fsop.list` 返回**路径字典序**（确定性遍历），本插件与设计口径一致保持字典序：
  `mtime` 不在 `fsop.list` 结果里、排序需额外 `stat` 且时间不参与确定性保证，回放要求结果确定。
- **`edit.bytes_written`**：`fsop.replace` 回传**真实写入字节数**（原子重写后整份文件大小，与 `write` 同口径），
  本插件原样透传；新建分支用 `fsop.write` 的 `bytes_written`。
- **`edit` 新建的 diff**：`fsop.replace` 已自算并回 `added` / `removed` / `patch`，替换分支原样透传；
  只有新建分支由本插件合成「空文件 → new」的 patch。
- **区外新建**：新建是**单 op**（`write` + `exclusive:true`），一次写类 `grant`（`op:"write"`）即可覆盖，
  不再有「`stat` 被档位拒导致区外新建不可达」的限制。
- **`workspace_root` 目录已删**：本插件不直接触盘，无法自行探测；由调用方 / `sandbox` 侧的存在性检查兜底。

## 运行

```sh
npm test                       # cargo test（协议帧 / describe 五工具 / invoke→fsop 映射 / 路径归类 / 错误与 grant 透传）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack → seed → start → 两身份 loaded → 直连服务协议驱动工具 + stop → verify/replay）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `Cargo.lock` / `README.md` / `schema/` / `execute/` 随源码入世。
