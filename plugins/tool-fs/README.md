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
| `read` | ✗ | read | `path` / `pattern?` / `offset?` / `byte_offset?` / `start_line?` / `end_line?` / `limit?` / `preview?` / `format?` / `mime?` / `max_files?` / `ignore?` | 单文件文本：`{text, total_lines, start_line, end_line, lines_returned, has_more, next_offset, content_truncated, next_byte_offset, file_bytes, hint, truncated, preview}`（`byte_offset` 模式另含 `byte_offset, bytes_returned, next_byte_offset, eof, file_bytes`）；单文件编码（`format:base64\|hex`）：`{text, encoding, binary, bytes_read, content_truncated, truncated, digest}`；单文件资产（`format:asset`）：`{asset:{kind,sha256,mime,size}, encoding, binary, bytes_read, content_truncated, truncated, digest}`；批量（给出 `pattern`）：`{files:[{path,text,…}], files_returned, files_matched, truncated, skipped, warning, digest}` |
| `edit` | ✗ | write | `path` / `old` / `new` / `replace_all?` | `{created?, replaced, bytes_written, added, removed, patch}` |
| `glob` | ✗ | read | `pattern` / `path?` / `depth?` / `min_depth?` / `tree?` / `ignore?` / `exclude?` / `limit?` | `{paths, tree, truncated, skipped_count, warning}`（`tree:true` 时 `paths:[]`、用 `tree`） |
| `grep` | ✗ | read | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `all?` / `any?` / `stats?` / `binary?` / `before?` / `after?` / `glob?` / `path?` / `ignore?` / `limit?` | `{matches, truncated, files_scanned, skipped, stats, mode, binary, base, glob, ignore, ignored_paths, ignored_paths_truncated, hint, warning}` |
| `stat` | ✗ | read | `path` / `pattern?` / `recursive?` / `max_files?` / `ignore?` / `sort_by?` / `order?` / `min_size?` / `max_size?` / `min_mtime?` / `max_mtime?` | 单路径：`{exists, is_dir, size, mtime, ctime, readonly, aggregate}`（`recursive` 且目录时 `aggregate` 非空）；批量（`pattern` 或 `path` 内联 glob）：`{files:[{path,exists,is_dir,size,mtime,ctime,readonly}], files_returned, files_matched, files_filtered_out, truncated, sort_by, order, aggregate, skipped, warning, digest}` |

- 文件可变，五个工具都标 `idempotent:false`（不进宿主结果缓存）。
- `stat`：只读元信息（`exists` / `is_dir` / `size` / `mtime` / `ctime` / `readonly`），供「是否存在 / 是否目录 /
  比较新旧」用；`readonly` 是跨平台只读位、`ctime` 为文件系统创建时间（不支持时 `null`），非完整权限审计。
  单路径直接查；给出 `pattern`（或 `path` 内联 glob，如 `src/**/*.py`）即批量：先列出匹配路径、再逐个查询，
  回 `files_returned` / `files_matched` / `files_filtered_out` / `aggregate`（文件 / 目录数、总大小、最老最新 mtime）。
  批量可 `sort_by`（`name` 字典序 / `mtime` / `size`，缺省按 `name` 升序；`mtime` / `size` 缺省降序）与
  `min_size` / `max_size` / `min_mtime` / `max_mtime` 过滤，`aggregate` 基于过滤后的返回集。
  目录 + `recursive:true` 时 `aggregate` 回整棵子树的聚合（同 `walk_files`：不跟随目录符号链接、确定性遍历）。
  `mtime` / `size` 排序取自文件系统、不参与确定性保证；**不用于替代 `glob` 的有序遍历**
  （`glob` 保持路径字典序以保证重放确定）。
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
| `read`（单文件） | `read` | `offset?` / `byte_offset?` / `start_line?` / `end_line?` / `limit`（缺省 2000）/ `preview?`（缺省 50 行）/ `encoding=format?`（`asset` 时另经 `host.asset.put`） |
| `read`（批量，`pattern`） | `list` 后逐个 `read` | `list`: `pattern` / `base=path` / `ignore` / `limit=max_files`（缺省 20）；每个文件 `read`: 同单文件行窗 |
| `edit`（`old` 非空） | `replace` | `old` / `new` / `replace_all?` |
| `edit`（`old` 空） | `write` | `data=new` / `create:true` / `exclusive:true` |
| `glob` | `list` | `pattern` / `base=path?` / `depth?` / `min_depth?` / `tree?` / `ignore` / `limit`（缺省 200） |
| `grep` | `grep` | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `all?` / `any?` / `stats?` / `binary?` / `before?` / `after?` / `glob?` / `base=path?` / `ignore` / `limit`（缺省 200） |
| `stat`（单路径） | `stat` | `path` / `recursive?` |
| `stat`（批量，`pattern` 或 `path` 内联 glob） | `list` 后逐个 `stat` | `list`: `pattern` / `base=path` / `ignore` / `limit=max_files`（缺省 200）；每个路径 `stat`；本插件按 `sort_by` / `order` / `min_size` / `max_size` / `min_mtime` / `max_mtime` 过滤排序 |

- `glob` / `grep` 的 `path?` 映射 `fsop.base`；`ignore` 原样传。
- 忽略表优先级：工具 `args.ignore` > 调用方 `bag.ignore`（装配来源：工具身份 body `ignore`，否则
  `#2 config` 的 `tools.ignore` 项目级兜底；经入口装配下传）> 内置兜底
  （`.git` / `node_modules` / `target` / `__pycache__` / `.venv`，与 `schema/tool-fs.json` 一致）。
  **显式空数组表示「不忽略」**；忽略条目按路径段匹配并在遍历时对目录整棵剪枝（`target` 即剪掉整棵 `target/`），
  含 `/` 的条目按相对路径 glob。
- `glob` 的 `exclude` 叠加到忽略表之上（命中即过滤、目录整棵剪枝），用于临时排除 `.next` / `__pycache__` 等，
  而不改动 `ignore`（缺省仍回落内置兜底）。`depth` 与 `min_depth` 按相对起始目录的路径段数组成深度区间
  （`depth` = 最大、`min_depth` = 最小）；**结果始终按路径字典序**（不含 `sort_by`、不按时间，重放确定）。
  按大小 / 时间过滤或按时间排序交给 `stat` 批量（元信息工具）。
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
- **批量读**：`read` 给出 `pattern` 即进入批量模式，`path` 视为目录基准，按 glob 列出匹配文件后逐个读取
  （`offset` / `limit` / `preview` 对每个文件生效）。结果按 `list` 的路径字典序返回（确定性），并回显
  `files_returned` / `files_matched`；`max_files`（缺省 20）限制文件数、`output_max` 限制总量，超出即截断；
  单个文件为二进制 / 超限 / 不可读 / 拒权时**跳过**并计入 `skipped`，整体在 `warning` 里说明（不因单个文件
  失败而中断整批）。`ignore` / `path` 语义同 `glob`。批量结果无单一 `text`，渲染器按 `files` 拼分段正文。
- `offset` 非整型 / 负值、`limit` 非正整数（0 / 负 / 非整型）→ `bad_args`（不静默夹取）；越界 `offset` 仍合法
  （sandbox 夹到文件尾，空窗口）。
- **行范围**：`start_line` / `end_line`（均为 1 基、闭区间）折成 sandbox 的 `offset` / `limit` 并覆盖之；
  `end_line < start_line` 或任一方非正整数 → `bad_args`。只给 `start_line` 时 `limit` 取行窗缺省，
  只给 `end_line` 时从首行读到该行。批量下对每个文件生效。
- `read` 结果带窗口元信息：`start_line` / `end_line`（1 基）、`lines_returned`；有后续行时 `has_more:true`，
  用 `next_offset`（0 基，等价下一次 `offset`）续读；`content_truncated:true` 表示内容被 `output_max` 按字节
  截断（末行可能不完整）。此时结果给出按完整行对齐的 `next_byte_offset` 与可读 `hint`：用 `byte_offset=next_byte_offset`
  再次 `read` 即可继续，单次仍受 `output_max` 约束，故可读完任意大文件（`eof:true` 表示已到文件尾）。
  `byte_offset` 模式下 `text` 为字节窗口切出的完整行、附 `byte_offset` / `bytes_returned` / `next_byte_offset` / `eof`，
  且与 `offset` / `limit` / `start_line` / `end_line` / `preview` 互斥（同给报 `bad_args`）。`truncated` 保留旧口径（窗口非全文即真）。
- `grep` 的 `mode`（`literal` / `regex`）缺省时按模式内容自动选择：含强正则信号（交替 `|`、类简写 `\d`
  等、转义元字符、`{n}` 重复）的模式按正则处理，其余按字面，避免 `TODO|FIXME` 静默空返；也可显式
  `mode:"literal"` / `mode:"regex"` 强制。`regex` 走手写简易正则
  （无外部依赖、确定性）：支持交替 `|`、分组 `()`、量词 `*`/`+`/`?`/`{n}`/`{n,}`/`{n,m}`、锚点 `^`/`$`、
  字符类 `[...]`、类简写 `\d`/`\D`/`\w`/`\W`/`\s`/`\S`、转义元字符与 `\n`/`\t`/`\r`；不支持反向引用 / 环视 /
  非贪婪量词。真语法错误（未闭合分组或类 / 悬空量词 / 尾反斜杠 / 未知转义 / `max<min`）即 `bad_args`，不静默按字面匹配。
- `glob` 的 `pattern` 与 `grep` 的 `glob` 过滤器共用同一 glob 语法：`*` / `**` / `?` / `[...]` / `{a,b,c}`
  大括号分组（含嵌套与整数区间 `{1..3}`）。故 `*.{py,yml,yaml}` 一个模式即可覆盖多后缀，
  不必拆成多次调用（此前大括号被当字面量，会静默滤空）。
- `grep` 结果回显生效参数 `mode` / `base` / `glob` / `ignore` / `ignored_paths`，并回审计统计
  `files_scanned`（已过 glob / ignore 过滤、参与匹配的候选文件数）；
  **空结果且 `glob` 把候选滤空**（`files_scanned:0`）时回 `hint` 指出是 glob 过滤所致；
  **literal 下空结果 + 模式像正则**（`literal_empty_hint`）时另回 `hint`，提示可改用 `mode:"regex"`
  （该模式支持 `|` 与 `()`），避免 `TODO|FIXME|…` 这类模式静默空返被误判为「没有命中」。
  纯文本空结果不给 `hint`。
- **完整性 `warning`**：`glob` 截断时回 `results truncated: showing A of B matched paths …`；
  `grep` 截断或跳过二进制 / 超限 / 不可读文件时拼成一条 `warning`（完整时 `null`）。都在结果主体
  明确「结果可能不完整」，防止把局部清单当全量而漏报敏感信息。
- `grep` 另可透传 `ignore_case`（Unicode casefold，表驱动、未做 NFC/NFD 规范化）、`files_only`（每文件一条：首命中行号/文本 + `count`，
  用于「哪些文件含 X」省 token）、`before` / `after`（每条命中的上下文行数，0–20，附 `before`/`after` 数组）。
  这些只增字段、不改 `matches` 形状；渲染器按 `count`（>1 时）/ `before` / `after` 展示，缺省不显示。
- `grep` 的 `all` / `any` 为附加模式数组：`all` 要求命中行同时满足每个模式（AND），`any` 只要求满足其中任一
  （OR，与主模式一起构成 OR 集合）；两者叠加时先 OR 后 AND。模式与 `pattern` 同语义、同 `mode`。
  `stats:true` 只回审计聚合 `{files_with_matches, total_matches}`
  （`matches:[]`、不受 `limit` 截断），用于「有多少文件 / 多少行命中」而不拉回正文。
- `grep` 默认跳过二进制 / 超 `output_max` / 不可读的文件，跳过数量在结果 `skipped:{binary, too_large, unreadable}`
  回报（结果可能因此不完整）；`read` 默认命中二进制回 `binary_unsupported`。
- **二进制搜索**：`grep` 的 `binary:true` 把二进制文件也纳入搜索——按**原始字节 / Latin-1** 逐字节解释
  （ASCII 模式安全；非 UTF-8 字节按 Latin-1 解释），命中条目带 `binary:true`，结果回 `binary:true`；
  未开时仍计入 `skipped.binary`。
- **二进制读取**：`read` 的 `format:"base64"|"hex"` 按原始字节读出并编码，二进制文件也可读（仅单文件；
  行窗 / 预览不适用；按 `output_max` 截断原始字节），结果回 `encoding` / `binary` / `bytes_read` 与编码文本摘要。
  文本文件用该编码读时 `binary:false`。
- **二进制资产**：`read` 的 `format:"asset"` 把字节经 `host.asset.put` 内容寻址落宿主资产区（④ 不可重算、不进世界），
  只回引用 `{kind:"asset", sha256, mime, size}`（`mime` 缺省 `application/octet-stream`），**不把字节塞进上下文**；
  取字节用 `host.asset.get`（同 `ui-*` / `msg-dialect` 附件链路）。与 `base64`/`hex` 的区别：后者内联字节、前者只回引用。
- `host.asset.put/get` 是 pin 声明（`plugin.json` 已 pin `host`）：二进制读写走该通道（`read format=asset` / `grep binary`）。

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
