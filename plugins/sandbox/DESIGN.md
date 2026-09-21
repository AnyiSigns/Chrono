# #25 `sandbox`（隔离执行）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 25 / `sandbox` |
| 语言 | **Rust**（native OS 隔离：Job Object / namespaces / seccomp / landlock）；源码 + `Cargo.toml` 入世，二进制走宿主侧 ③ 依赖缓存；`docker` 实现为容器调用 |
| 职责 | 隔离执行（**多实现可换**）：Rust 原生 OS 级（win32 / linux）+ Docker 容器；一次性 `exec` + **结构化文件操作 `fsop`** + 资源上限；**4 档强制**（fs 范围；升级弹卡判定归 #26，本插件消费批准后一次性 `caps.grant`） |
| 依赖 | pins 无；`+` 2（`config.permission` 全局档与 **4 档 → fs 范围映射表**由调用链最上游入口 term（#14）读出后经 bag 传入（`bag.tier` / `bag.sandbox_tiers`，§1.14）；本插件服务**不读投影**，D8）（2026-09-20 修订）；`<-` 28 / 29 / 30 / 31（pins：隔离执行）；`#26` 判「工作区外 / 危险操作」升级（非 pins，见下） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["sandbox"]`，`methods: {sandbox:["exec","fsop","capabilities"]}`（`capabilities` 原名 `probe`，避与协议握手 `probe` 撞名；`fsop` = S2 结构化文件操作面，见下） |
| 命令 | 无 |
| schema | `schema/sandbox.json`（实现选择 `impl` / 资源缺省；**4 档 → fs 范围映射表不住 schema**——住**本身份数据世代 body**，`bag.sandbox_tiers` 由 #14 入口 term 读出传入，§1.14；热改 = 数据换代，schema 是身份契约出生即冻结）（2026-09-20 修订） |
| 机制 | 见下「4 档 / caps / 实现 / exec / 网络 / 平台」 |
| 边界 | 不做：工具语义（归 28–31）/ **升级判定**（归 26，本插件**永不发升级、只 `fs_denied`**；realpath 判越界而 #26 未升级 ⇒ **fail-closed 拒绝**，两判不一致时拒绝优先）（2026-09-20 修订）/ 审批等待（归 33）/ 网络策略决策（不设默认，见「网络」）/ 长驻交互会话（归 31 自管） |
| 验收 | 1) 资源上限生效（超时 / 内存 / 输出截断 / 进程数）；2) **四档 fs 范围按表强制**（进程内 realpath + 免竞态打开；OS 级隔离由 Docker 后端提供）（auto 全过 / severe 工作区 RW / review 工作区只读 / deny 全拒）（2026-09-20 修订）；3) severe 下工作区外 / 危险操作升级弹卡，**批准后凭一次性 `caps.grant`（绑定 call_id）放行该次**、`deny` 不执行；4) 换实现（native ↔ docker）不改 28–31；5) 明文密钥不进审计；6) 平台不支持时 `sandbox_unsupported` 明确；7) 临时产物清理、不落世界；8) **`fsop` 六 op 结构化**、`replace` 原子读改写且 `old` 非唯一 / `expected_hash` 不符 → `edit_conflict`、**逐路径档位强制在 #25**（#28 只声明）、二进制回 `binary_unsupported` |
| 状态 | 细节设计（2026-09-19）：Rust 原生（win32 + linux，mac 后补）+ Docker **同期**；**4 档做进沙箱**（强制 fs 范围；升级弹卡判定归 #26）；一次性 exec；**补批准后一次性 `caps.grant` 放行**；**S2 `fsop` 结构化文件操作面已展开**（供 #28；强制点/realpath/原子读改写均在本插件） |

## 4 档（做进沙箱，强制 fs 范围）

档位**全局**、住 `#2 config.permission`，由 **`#40` 输入框**选择；本插件按档**强制**：

| 档 | fs 读 | fs 写 | 升级（弹卡） |
| --- | --- | --- | --- |
| `auto` | 不限 | 不限（全过） | 无 |
| `severe` | 工作区 | 工作区 | **工作区外 / 危险操作 → 弹卡**（#39） |
| `review` | 工作区 | **无（只读工作区，写一律拒）** | — |
| `deny` | 全拒 | 全拒 | — |

- **单调**：`auto` > `severe` > `review` > `deny`（按放行程度）。
- **职责分离**：本插件**强制** fs 范围；`#26 guard` 只判「工作区外 / 危险操作」是否升级；`#33` 编排审批往返（`26 -> 27 -> 32 -> 39 -> 33`）；`deny` 直接不执行。
- **升级放行（写死，否则「批了也执行不了」）**：`severe` 的默认范围 = 工作区 RW；越界 / 危险调用**先被拒并升级**（不执行，本插件**永不发升级、只 `fs_denied`**）。**`caps.grant` 签发者 = #33**：裁决放行时构造 `{call_id, op, path, tier, expires}`（**不进世界**），随 `tool.dispatch` bag → #27 透传 → 提供者 → 本插件随 `exec` / `fsop` args 传入；本插件校验后才放宽，**grant 不可重放为常设权限**（2026-09-20 修订）。

### `caps.grant` 校验口径（可执行，写死）

grant 只放宽**被批准的那一次**，判定顺序固定（任一不符即回落档位强制 = fail-closed 拒绝）：

1. **`deny` 档短路**：`deny` 档下 fs 读写全拒，**任何 grant 都不放宽**（与 `exec` 同口径；`deny` 先于 grant 判定）。
2. **绑定字段**：`{call_id, op, path, tier, expires}` 缺一不可——`op` 必须等于本次 `fsop` 的 op；目标路径必须落在 `paths` 任一项之下；`tier` 必须等于当前档；`expires` 用帧 `env.now` 判（不取系统时钟）。
3. **`paths` 语义**：**为空 = 不适用（不构成 grant）**，而非「不限」；非空时逐项 realpath 解析后与目标比对。
4. **`fs` 不得缺省放宽**：只有 grant **显式声明**的 `fs.read` / `fs.write` 才放宽，且范围须覆盖所需；未声明即不额外放宽（不回落 `full`）。grant 只允许**收紧到显式声明**，不允许无声明放大。
5. **一次性**：`call_id` 消费后即拒；消费记录驻进程内存（容量上限 + TTL，凭据自身 `expires` 兜底）。

- **已知限制（如实登记）**：v1 的 bag 与模型 args 未做 provenance 隔离——伪造 `grant` 的防线依赖 #27 / #28 的可信字段边界 + 审批闸（#26 / #32 / #33），本插件只做上述机械校验，不证明 grant 确由 #33 签发。
- 映射表住**本身份数据世代 body**（`bag.sandbox_tiers` 由 #14 入口 term 读出传入，§1.14；**热改 = 数据换代**，不住 schema——schema 是身份契约出生即冻结）（2026-09-20 修订）。
- **对 agent 隐藏（已定）**：唯一插件写工具 = `plugin-admin`（#42），其**可见性过滤排除 `sandbox`**（与自己）⇒ agent 够不着；沙箱仍是**普通插件**、不设框架特权（唯一不变量仍是内核不可改）。人仍可经入站面改沙箱。`.worldignore` 不适用：改插件是写**新**源码 + `add_gen`/`set_active`，排除源码既挡不住写新世代、又会让宿主无法物化运行。

## caps（调用方声明 + 档位钳制）

```jsonc
// 工具声明需要什么；本插件按当前档的 fs 范围钳制，并强制
{ "fs": { "read": "full" | "workspace" | "none",         // 与 #27/#28 的 caps 形状一致（含 fs.read，D11）
          "write": "full" | "workspace" | "none" },
  "net": "none" | "limited" | "all" | "unset",           // 网络能力；**按 permission 四档钳制**（none / limited = 声明 hosts 白名单 / all），映射表同住 body；越档 `net_denied`（2026-09-20 修订）
  "timeout_ms": 30000, "mem_mb": 1024, "cpu_ms": 0,
  "output_max": 1048576, "procs_max": 32 }
```

- `caps` 由工具声明（`tool-http` / `tool-browser` 需 `net`；`tool-fs` / `tool-shell` 需 `fs.read` / `fs.write`）；本插件取**声明 ∩ 当前档范围**后强制，越界 → `fs_denied`（本插件**永不发升级**；升级判定归 #26 **词法预判、派发前**）或（severe）由 #26 升级弹卡（2026-09-20 修订）。
- **`bag` 至少带 `{ caps, tier, workspace_root, sandbox_tiers }`**：`tier`（= `config.permission` 当前档）、`workspace_root` 与 4 档映射表 `sandbox_tiers` 均由**调用链最上游入口 term（#14）**装配经 bag 传入（§1.14），本插件服务**不读投影**（D8）（2026-09-20 修订）。

## 实现（多实现可换，同期两套）

| 实现 | 机制 | 说明 |
| --- | --- | --- |
| `native`（Rust 二进制，随 npm 包投递、**不入世**） | win32：Job Object（进程树 / 内存 / CPU / 句柄上限）+ AppContainer / 低完整性（fs 写范围）；linux：namespaces（user / mount / pid / net）+ seccomp（syscall 白名单）+ landlock（fs 写范围） | 无外部运行时依赖；mac 后补（未实现平台返回 `sandbox_unsupported`） |
| `docker`（同期） | 容器：`--network` / `--read-only` + bind mount（工作区）/ `--memory` / `--cpus` / `--pids-limit` / `--user` | 依赖外部运行时；不可用 → `sandbox_unsupported` |

- `impl` 住 schema / config（`native` / `docker`）；`capabilities` 报本机可用实现与平台能力（自述面，供 UI 展示；**改名以避与协议握手 `probe` 撞名**）。
- **`capabilities.enforcement` 如实自述**：`fsop` = `in_process`（进程内 realpath + 打开语义）；`exec_fs` = `none`（native 的 `exec` 不做 fs 范围强制，Docker 的 OS 级隔离见其 `features`）；`net` = `declaration`（`caps.net` 越档 `net_denied`，实现尽力）。`exec_fs` 不得报 `declaration`——native 无任何声明检查。
- **Docker 已知限制**：`limited` 网络白名单未实现，一律回落 `--network none`（fail-closed）；容器调用（`--read-only` / `--user` / bind mount / `--memory` / `--pids-limit`）本机无 docker，未验证。
- 二进制与 ONNX 运行时同路（#20 先例）：**入世只有 Rust 源码 + Cargo 清单**，`target/` 编译产物走 `.worldignore`（宿主侧 ③）。

## exec

```
exec(bag) -> { exit_code, stdout, stderr, truncated, duration_ms, artifacts? }
```

- **`exec` args 增 `env` 通道（2026-09-20 修订）**：键值表下传子进程环境；宿主端口审计对 args 顶层 `env` 值脱敏（H19，待落地）；#29 密钥经此通道。

- **一次性**：一次 `exec` 一进程（或一容器），无 stdin 交互；cwd = `bag.workspace_root`（由 #27 解析后 bag 传，见 #41）；#28 / #29 反向调 #25 时把 `workspace_root` 随 args 透传（本插件服务**不读投影**，D8）；临时目录住宿主侧 ③、结束清理。
- 超时 / 超内存 / 超输出 → 杀**进程树**（native：Job Object / 进程组；docker：`--rm` + kill）。
- **stdout / stderr 截断**到 `output_max`；明文密钥不出现在审计（密钥经 #24 句柄 → **`exec` args 的 `env` 字段**注入子进程环境，不落 args 明文；端口审计对 `env` 值脱敏 = H19，待落地）（2026-09-20 修订）。
- 临时产物 / 端口 / pid **不进世界**；产物引用若需回写由调用工具声明。

## 结构化操作 `fsop`（S2，2026-09-19 展开）

`exec` 是"任意命令"的兜底；**结构化文件操作**另设 `fsop`——由 #28 `tool-fs` 调用，避免 shell 转义、给出逐操作的结构化结果与逐路径的档位强制。

```
fsop(bag) -> { ok:true, op, result } | { ok:false, code, message }
bag = { op, path, args, caps, tier, workspace_root, grant? }
```

| op | args（要点） | result | 幂等 |
| --- | --- | --- | --- |
| `stat` | — | `{ exists, is_dir, size, mtime }` | ✓ |
| `read` | `offset?` / `limit?` | `{ text, total_lines, truncated, binary }` | ✓ |
| `list` | `pattern?` / `base?` / `ignore?` / `limit?` | `{ paths:[…], truncated }` | ✓ |
| `grep` | `pattern` / `glob?` / `base?` / `ignore?` / `limit?` | `{ matches:[{path,line,text}], truncated }` | ✓ |
| `write` | `data` / `create?` / `expected_hash?` | `{ bytes_written, created, hash }` | ✗ |
| `replace` | `old` / `new` / `replace_all?` / `expected_hash?` | `{ replaced, added, removed, patch }` | ✗ |

- **`base` / `ignore` 参数（2026-09-20 修订）**：`base` = path 基准；`ignore` = 忽略表（调用方传入，住本身份数据世代 body）。
- **强制点在 #25，不在 #28**：#25 独立做 `realpath(path)` 并与 `workspace_root` 比对（防符号链接逃逸），取「#28 声明的 `caps.fs.*` ∩ 当前 `tier` 范围」后执行；**免竞态打开语义**：读路径 realpath 校验与文件打开在同一受限上下文内完成，打开后重新 `canonicalize` 复核路径未变；**写路径统一走「临时文件 + rename」**（rename 替换目标链接本身、不写穿符号链接）；#28 的「区内 / 区外」归类只是**声明**，越界由 #25 拒 `fs_denied`（本插件**永不发升级**；升级判定归 #26 词法预判、派发前；realpath 判越界而 #26 未升级 ⇒ **fail-closed 拒绝**）（2026-09-20 修订）。
- **原子读改写**：`replace` 在**一次 `fsop` 内**完成 read→比对→write（不给 #28 留 TOCTOU 窗口）；`old` 未命中或非唯一 → `edit_conflict`；`expected_hash`（可选）= 调用方读到的旧内容哈希，不符 → `edit_conflict`（乐观并发）。
- **v1 只做文本**：命中二进制 → `binary_unsupported`；**`read` 超 `output_max` 返回截断内容 + `truncated:true`（标记，非错）**，`too_large` 只留给 `write` / `replace` 的输入或既有文件超限；`host.asset.put/get`（**S1 已落地**）是 **#28 / #30 / #31** 的二进制前置（它们 pin host）；**本插件不 pin host、不经资产面**（2026-09-20 修订）。
- **与 `exec` 同一套资源上限与隔离**（native / docker 共用）；`fsop` 不启动子进程，由 #25 在受限上下文内直接触盘。**诚实口径（2026-09-20 修订）**：`fsop` 为**进程内校验**（非 OS 级隔离；Docker 后端才是真 OS 隔离）——多实现可换，四档强制在进程内为 realpath + 打开语义强制。
- **`caps.grant`**：与 `exec` 同规——批准后一次性放宽**本次** `fsop`，绑定 `{call_id, op, path, tier, expires}`；`deny` 档短路、`paths` 空视为不适用、`fs` 未声明不放宽（详见上「`caps.grant` 校验口径」）。不进世界、不可重放为常设权限。
- **#28 不直接触盘**：#28 的四个工具全部映射为 `fsop`（`read`→`read`、`edit`→`replace` / `write`、`glob`→`list`、`grep`→`grep`），结果由 #25 回、#28 结构化后回 #27。

## 网络

- **本插件不设默认网络策略、不做网络决策**；**`caps.net` 四档钳制**（`none` / `limited`（声明 hosts 白名单）/ `all`，映射表同住 body）：越档 `net_denied`（错误码已登记 `protocol.md` §四）；**声明级强制 + 实现尽力**（win32 原生后端尽力、Docker 后端真隔离）；`#30` / `#31` 的网络出口受此钳制（2026-09-20 修订）。
- 实验簇（chrono-agent-graph）的「默认无网」是**该实验自己的策略**，不落本插件默认。

## 平台与失败

- v1：**win32 + linux**；mac 后补（`sandbox_unsupported`）。Docker 可用时优先（若配置）。
- 失败码：`sandbox_unsupported`（平台 / 运行时不可用）、`sandbox_setup_failed`、`timeout`、`oom`、`cpu_exceeded`、`output_max`、`procs_max`、`output_truncated`（非错，标记）、`fs_denied`（越界被拒）、`net_denied`（网络越档被拒，错误码已登记 `protocol.md` §四）（资源上限码对齐 #29，2026-09-20 修订）。
- `fsop` 追加：`bad_path`（形态非法）、`path_not_found` / `not_a_directory`、`permission_denied`（触盘权限不足，**不归** `path_not_found`）、`edit_conflict`（`replace` 的 `old` 未命中 / 非唯一 / `expected_hash` 不符）、`too_large`（`write` / `replace` 输入或既有文件超 `output_max`；`read` 超限是 `truncated` 标记、非错）、`binary_unsupported`（v1 文本限制）。

## 跨插件登记

- **#26 guard**：本插件**强制** fs 范围（4 档做进沙箱）+ 消费一次性 `caps.grant`；guard **独占**「危险 / 越界」定义（**本身份数据世代 body，`bag.guard_rules`**，2026-09-20 修订），本插件不读该定义、只按 caps 与 grant 强制。
- **#40 ui-composer / #2 config**：档位全局、由输入框写 `config.permission`；档位由调用方入口 term 读投影后经 bag 传入（本插件服务**不读投影**，D8）；改档 = 改 config（数据热生效，进程不动）。
- **#28–31**：工具声明 `caps`、pin 本插件；换 `impl` 不改工具。
- **#28 `tool-fs`（版本提升：被提升方，**S2 已展开**）**：① **结构化操作执行面 `fsop`** 已定（见上，`sandbox:["exec","fsop","capabilities"]`）；② `severe` 的 fs 范围与「区外」判据已对齐（**区内 / 区外读写都经本插件强制**，区外 = 超出默认范围）；③ 二进制经 **S1 `host.asset.put/get`**（已落地）——是 **#28 / #30 / #31** 的二进制前置（它们 pin host），**本插件不 pin host、不经资产面**（2026-09-20 修订）。提出方登记见 `plugins/tool-fs/DESIGN.md`。
- **#20 embedding**：二进制 / 编译产物走 `.worldignore` 的先例。
- **#41 workspace**：`bag.workspace_root` 为 cwd（非 pin）。
