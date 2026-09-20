# #28 `tool-fs`（文件工具）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 28 / `tool-fs` |
| 语言 | **Rust**（`glob` / `grep` 扫描用 ignore/regex 一类的原生实现；路径与范围归类也原生）。与 #20/#25 同路：源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧 ③ 依赖缓存；触盘仍全部经 #25 `fsop` |
| 职责 | **结构化文件读写（工作区内 + 工作区外）**，四个工具：`read`（读 / 行窗口）/ `edit`（精确替换，含新建）/ `glob`（按模式找文件）/ `grep`（按模式找内容）；**路径与范围判定（区内 / 区外）是本插件独有职责** |
| 依赖 | `->` 25（pins：所有触盘操作经其隔离 / 档位强制）；`<-` 27（pins：按 `tool` 端口契约派发）；执行根由 #27 解析后 **bag 传 `workspace_root`**（不 pin #41） |
| 成员 | execute, schema（无 terms：服务经**反向帧 `port.call`** 调 #25，`docs/protocol.md` §2.4） |
| 能力类·方法 | `implements: ["tool-fs"]`，`methods: {"tool-fs":["describe","invoke"]}`（**类名 = 身份名**；`describe` 回工具名 `read` / `edit` / `glob` / `grep`，见 `plugins/tools/DESIGN.md`「`tool` 端口契约」） |
| 命令 | 无 |
| schema | `schema/tool-fs.json`（工具开关 / 大小与行窗口缺省 / 忽略表 / 二进制策略；可热改） |
| 机制 | 见下「四个工具 / 路径与范围 / 区外读写 / 隔离 / 大小与二进制 / 错误码」 |
| 边界 | 不做：绕过 guard / sandbox（**区内、区外都经 #25 强制、区外写类经 #26 升级**）/ **通用命令与脚本执行（归 29 `shell`）** / 工具语义判定（归 26）/ 派发（归 27）/ 目录改名追踪（归 41） |
| 验收 | 1) 四个工具经 #27 目录可发现、`argsSchema` 机械可校验；2) **区内**读写按档位放行 / 拒绝；3) **区外**读写按档处理：`auto` 直落、`severe` 升级弹卡、`review` / `deny` 拒；批准后凭一次性 `caps.grant` 只放行本次；4) 形态非法路径（空 / NUL / 非法字符）拒 `bad_path`，档位拒绝 `fs_denied`；5) `read` / `glob` / `grep` 命中宿主幂等缓存、`edit` 永不缓存；6) 换 #25 实现不改本插件；7) 结果确定可回放（时间由 bag 传入） |
| 状态 | 细节设计（2026-09-19）：按 `tool` 端口契约展开；工具集按用户口径定为 `read` / `edit` / `glob` / `grep`；**工作区外读写明确要做**（`..` / 绝对路径合法，区外范围与升级归 #25 / #26，不再当非法路径）；**pins 更正**：本插件不解析密钥，去掉总表 §1.7 的 `24`（见「跨插件登记」） |

## 四个工具（`describe` 暴露）

| 工具名 | 幂等 | `caps.fs` | args（要点） | 结果 |
| --- | --- | --- | --- | --- |
| `read` | ✓ | read | `path` / `offset?` / `limit?` | `{text, total_lines, truncated}`（行窗口；行号可选） |
| `edit` | ✗ | write | `path` / `old` / `new` / `replace_all?` | `{created?, replaced, bytes_written, added, removed, patch}`（`patch` = unified diff，供对比渲染） |
| `glob` | ✓ | read | `pattern` / `path?` / `limit?` | `{paths:[…], truncated}`（按最近修改排序） |
| `grep` | ✓ | read | `pattern`（字面 / 正则）/ `glob?` / `path?` / `limit?` | `{matches:[{path,line,text}], truncated}` |

## 渲染（`describe.render`，本轮定）

| 工具 | `form` | `label` | `summary`（折叠态） | `tone` | `detail`（展开态） |
| --- | --- | --- | --- | --- | --- |
| `read` | **`line`** | `read` | `{path}` | — | 无（消息流里一行「read 文件名」，不可展开） |
| `edit` | `card` | `edit` | `{path}  +{result.added} -{result.removed}` | `plain` | `{kind:"diff", patch}`（**添加 / 删除 / 修改对比**） |
| `glob` | `card` | `glob` | `{pattern}` | **`ghost`** | `{kind:"paths", paths}` |
| `grep` | `card` | `grep` | `{pattern}`（有 `glob` 时 `{pattern}  {glob}`） | **`ghost`** | `{kind:"matches", matches}` |

- **`read` 是一行不是卡片**：只在消息流里留一行「read 文件名」，不折叠、不展开（读文件的结果不占展示面积）。**`form:"line"` 时 `tone` 忽略**（故 `read` 的 `tone` 记 `—`）。
- **`edit` 默认收缩**：前面 `edit`，后面文件名 + 变更行数（`+added -removed`）；**展开显示改动区域并做对比**（新增 / 删除 / 修改逐行标色），数据来自结果里的 `patch`（统一 diff）。
- **`grep` / `glob` 用近乎透明卡片**（`tone:"ghost"`）：默认收缩，`grep` 前面跟 agent 输入的参数（pattern / glob），展开显示工具输出（`grep` = 命中列表，`glob` = 文件列表）。

- **`edit` 的两种形态**：`old` 非空 ⇒ **精确替换**（`old` 必须唯一命中，否则 `edit_conflict`；`replace_all:true` 时全部替换）；`old` 为空且文件不存在 ⇒ **新建**（`new` 为初始内容）。这样「读 + 写」由 `read` / `edit` 两个工具承担，不另设 `write`。
- **幂等类**（`read` / `glob` / `grep`）由宿主按 `(port, method, canonicalJson(args))` 缓存（`kernel.md` §十二 门外逃生舱）；`edit` `idempotent:false`，永不缓存、永不 memo。
- 每个工具各自声明 `argsSchema`（白名单子集）与 `caps`（**`{fs:{read,write}, net}` 对象形、含 `fs.read`**，与 #25 一致，D11）；`describe` 一次回报全部。

## 路径与范围（本插件独有职责）

- **两种输入都合法**：相对路径（基准 `bag.workspace_root`）与**绝对路径**（含区外）；`..` 段按解析规则规范化，**不直接判错**。形态非法（空串 / NUL / 非法字符）→ `bad_path`（机械拒，不触盘）。
- **判定目标落在哪**：realpath 后与 `bag.workspace_root` 比对（防符号链接逃逸）——
  在根内 = **区内**（`caps.fs.* = "workspace"`）；在根外 = **区外**（`caps.fs.* = "full"`）。**区外不是非法**，是另一档范围。
- **区外不由本插件说了算**：范围与档位由 #25 强制、升级由 #26 判（见下「区外读写」）；本插件只做机械的"路径 → 区内 / 区外"归类与结果结构化。
- 根缺失 / 目录已删 → `workspace_missing`（#41 口径）；**绝对路径不需要 `workspace_root` 也能解析**（无工作区时仍可区外读写，按档）。
- 忽略表（`glob` / `grep` 用）住本插件 `schema`（**策略数据、可热改**）；改它 = 写本身份世代，走审批闸 / #42 可见性过滤；本插件**不提供运行时改它的命令**。

## 区外读写（依赖 #25 + #26，本插件必须做）

| 档 | 区外读 | 区外写 |
| --- | --- | --- |
| `auto` | 放行 | 放行 |
| `severe` | **升级弹卡**（区外 = 超出 #25 默认范围） | **升级弹卡** |
| `review` | 拒 `fs_denied`（只读工作区） | 拒 `fs_denied` |
| `deny` | 拒 | 拒 |

- **批准路径（跨 run）**：`#27` 派发前 eff `26` → `escalate` → `#33` 入队 `#32` → `#39` 裁决 → 宿主按游标新 run → 本插件收到 `bag.grant` → **透传 #25** 放行**本次**。`grant` 不进世界、不可重放为常设权限。
- **升级判定不在本插件**：本插件只声明"这次是区外 + 读 / 写"；是否弹卡由 #26（`schema/guard.json` 启发式）判。
- **已对齐**：`plugins/guard/DESIGN.md` 的「工作区外」启发式已改为**读写都升级**（区外即超出 #25 `severe` 默认范围），与本表一致。
- 区外**不做**目录改名追踪（归 #41）。

## 隔离（依赖 #25，不直接触盘）

- 每个操作 = 一次**反向帧 `port.call`** 到 #25（按本插件 `pins` 路由，`docs/protocol.md` §2.4），由 #25 在隔离环境内执行并强制档位；本插件**不直接触盘**。
- `caps` 用 **`{fs:{read,write}, net}` 对象形**（含 `fs.read`，D11；与 #25 冻结形状一致）；`caps.fs.read` / `caps.fs.write` 由本插件按**目标落在区内还是区外**声明（区内 `"workspace"` / 区外 `"full"`），由 #25 取「声明 ∩ 当前档」后强制；档位拒绝 → `fs_denied`。
- **区外（`severe` 档）升级**：由 #26 判 `escalate`（在 #27 派发前）；批准后凭**一次性 `caps.grant`**（绑定 `call_id`）随 `invoke` 传入 → 本插件**透传**给 #25 放行**本次**；`grant` 不进世界、不可重放为常设权限。
- `review` 档 = 工作区只读 ⇒ 区内 `edit` 与**全部区外访问** `fs_denied`；`deny` 档全拒。
- 换 #25 实现（native / docker）本插件零改动。
- **工具 → `fsop` op 映射（S2 已展开）**：`read` → `fsop.read`；`edit` → `fsop.replace`（`old` 非空）/ `fsop.write`（`old` 空且文件不存在 = 新建）；`glob` → `fsop.list`；`grep` → `fsop.grep`（`stat` 供路径存在性判定）。**路径形态校验（`bad_path`）与结果结构化在本插件**；**`realpath` / 区内·区外强制 / 原子读改写 / `edit_conflict` 在 #25**（强制点唯一，#28 的归类只是声明）。

## 大小与二进制

- 文本读写：UTF-8；`read` 默认行窗口（`offset` / `limit`），单次输出 ≤ `output_max`，超限截断并标记 `truncated`（标记，非错）。
- **二进制 / 大文件 v1 不内联**：命中二进制或超上限 → `binary_unsupported` / `too_large`（结构化失败，不静默）。
  > **宿主能力（S1 已落地）**：`host.asset.put` / `host.asset.get`（服务侧字节存取，规范 base64、8 MiB 内联上限；见 `host.md` §五 宿主扩展面）。本插件实现时二进制读写可用；**本插件尚未实现**，验收待插件落地。

## 错误码

| 码 | 触发 |
| --- | --- |
| `bad_path` | 形态非法（空串 / NUL / 非法字符）——**`..` / 绝对路径不再算错** |
| `fs_denied` | 档位范围外（`review` 写 / `review`·`deny` 区外 / `deny` 全部） |
| `workspace_missing` | `workspace_root` 缺失或目录已删 |
| `path_not_found` / `not_a_directory` | 目标不存在 / 类型不符 |
| `edit_conflict` | `edit` 的 `old` 未命中或非唯一 |
| `too_large` / `binary_unsupported` | 超上限 / 二进制（v1 不支持） |
| `output_truncated` | 输出被截断（标记，非错） |
| `tool_failed` / `tool_timeout` | #25 执行失败 / 超时（原样透传） |

## 与 #29 的分工

- #28 = **结构化文件读写**：按工具建模、路径与范围判定（区内 / 区外）、结果结构化、只读类幂等可缓存、审计粒度细。
- #29 `shell` = **任意命令 / 脚本执行**：结果是非结构化 stdout / stderr。
- 需要"跑一条命令 / 一段脚本"用 #29；需要"读 / 改 / 找文件"用 #28。
- 两者都经 #26 → #25，不重叠、不互相调用。

## 跨插件登记

- **#25 sandbox**：本插件 `->` 25，所有操作（**含区外**）经其 `fsop` 隔离 / 档位强制（反向帧 `port.call`）；`caps.fs`（区内 `workspace` / 区外 `full`）与一次性 `caps.grant` 见上；**版本提升（提出方登记已落地）**：S2 `fsop` 设计已展开（实现待 #25）、`severe` fs 范围与「区外」判据已对齐（见 `plugins/sandbox/DESIGN.md`）。
- **#26 guard**：区外读 / 写是否升级由 #26 判（本插件只声明"区外 + 读 / 写"）；已对齐——#26 的「工作区外」启发式改为**读写都升级**，与本插件「区外读写都依赖沙箱」一致。
- **#27 tools**：按 `tool` 端口契约被派发；执行根 `workspace_root` 由 #27 bag 传（本插件不 pin #41）。
- **总表 §1.7 更正（已同步）**：`#28` 依赖原写 `-> 24、25`，本插件**不解析密钥**（无 `auth_ref` 可解），故 pins 只 `-> 25`；总表该行已同步为 `-> 25`。
- **宿主能力**：反向帧 `port.call`（已在 `docs/protocol.md` §2.4 落地）；**S1 服务侧资产存取面已落地**（`host.asset.put/get`，二进制读写前置，`host.md` §五 宿主扩展面）。
