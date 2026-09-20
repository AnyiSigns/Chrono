# #25 `sandbox`（隔离执行）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 25 / `sandbox` |
| 语言 | **Rust**（native OS 隔离：Job Object / namespaces / seccomp / landlock）；源码 + `Cargo.toml` 入世，二进制走宿主侧 ③ 依赖缓存；`docker` 实现为容器调用 |
| 职责 | 隔离执行（**多实现可换**）：Rust 原生 OS 级（win32 / linux）+ Docker 容器；一次性 `exec` + **结构化文件操作 `fsop`** + 资源上限；**4 档强制**（fs 范围；升级弹卡判定归 #26，本插件消费批准后一次性 `caps.grant`） |
| 依赖 | pins 无；`+` 2（`config.permission` 全局档由调用方入口 term（#27 `dispatch`）读 `ctx.ids.config.body.permission` 后经 bag 传入；本插件服务**不读投影**，D8）；`<-` 28 / 29 / 30 / 31（pins：隔离执行）；`#26` 判「工作区外 / 危险操作」升级（非 pins，见下） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["sandbox"]`，`methods: {sandbox:["exec","fsop","capabilities"]}`（`capabilities` 原名 `probe`，避与协议握手 `probe` 撞名；`fsop` = S2 结构化文件操作面，见下） |
| 命令 | 无 |
| schema | `schema/sandbox.json`（实现选择 `impl` / 资源缺省 / **4 档 → fs 范围映射表**；可热改） |
| 机制 | 见下「4 档 / caps / 实现 / exec / 网络 / 平台」 |
| 边界 | 不做：工具语义（归 28–31）/ **升级判定**（归 26）/ 审批等待（归 33）/ 网络策略决策（不设默认，见「网络」）/ 长驻交互会话（归 31 自管） |
| 验收 | 1) 资源上限生效（超时 / 内存 / 输出截断 / 进程数）；2) **四档 fs 范围按表强制**（auto 全过 / severe 工作区 RW / review 工作区只读 / deny 全拒）；3) severe 下工作区外 / 危险操作升级弹卡，**批准后凭一次性 `caps.grant`（绑定 call_id）放行该次**、`deny` 不执行；4) 换实现（native ↔ docker）不改 28–31；5) 明文密钥不进审计；6) 平台不支持时 `sandbox_unsupported` 明确；7) 临时产物清理、不落世界；8) **`fsop` 六 op 结构化**、`replace` 原子读改写且 `old` 非唯一 / `expected_hash` 不符 → `edit_conflict`、**逐路径档位强制在 #25**（#28 只声明）、二进制回 `binary_unsupported` |
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
- **升级放行（写死，否则「批了也执行不了」）**：`severe` 的默认范围 = 工作区 RW；越界 / 危险调用**先被拒并升级**（不执行）。批准后由宿主把回执作为该次调用的**一次性 `caps.grant`**（绑定 `call_id`，只放宽本次、用完即弃）随 `exec` 传入；本插件校验 grant 的 `call_id` / 范围 / 档位后才放宽，**grant 不进世界、不可重放为常设权限**。
- 映射表住 `schema/sandbox.json`（**世界数据、可热改**）。
- **对 agent 隐藏（已定）**：唯一插件写工具 = `plugin-admin`（#42），其**可见性过滤排除 `sandbox`**（与自己）⇒ agent 够不着；沙箱仍是**普通插件**、不设框架特权（唯一不变量仍是内核不可改）。人仍可经入站面改沙箱。`.worldignore` 不适用：改插件是写**新**源码 + `add_gen`/`set_active`，排除源码既挡不住写新世代、又会让宿主无法物化运行。

## caps（调用方声明 + 档位钳制）

```jsonc
// 工具声明需要什么；本插件按当前档的 fs 范围钳制，并强制
{ "fs": { "read": "full" | "workspace" | "none",         // 与 #27/#28 的 caps 形状一致（含 fs.read，D11）
          "write": "full" | "workspace" | "none" },
  "net": true | false | "unset",                         // 沙箱不设默认；按声明与实现能力尽力
  "timeout_ms": 30000, "mem_mb": 1024, "cpu_ms": 0,
  "output_max": 1048576, "procs_max": 32 }
```

- `caps` 由工具声明（`tool-http` / `tool-browser` 需 `net`；`tool-fs` / `tool-shell` 需 `fs.read` / `fs.write`）；本插件取**声明 ∩ 当前档范围**后强制，越界 → `fs_denied` 或升级弹卡（severe）。
- **`bag` 至少带 `{ caps, tier, workspace_root }`**：`tier`（= `config.permission` 当前档）与 `workspace_root` 均由调用方入口 term（#27 `dispatch`）读投影后经 bag 传入，本插件服务**不读投影**（D8）。

## 实现（多实现可换，同期两套）

| 实现 | 机制 | 说明 |
| --- | --- | --- |
| `native`（Rust 二进制，随 npm 包投递、**不入世**） | win32：Job Object（进程树 / 内存 / CPU / 句柄上限）+ AppContainer / 低完整性（fs 写范围）；linux：namespaces（user / mount / pid / net）+ seccomp（syscall 白名单）+ landlock（fs 写范围） | 无外部运行时依赖；mac 后补（未实现平台返回 `sandbox_unsupported`） |
| `docker`（同期） | 容器：`--network` / `--read-only` + bind mount（工作区）/ `--memory` / `--cpus` / `--pids-limit` / `--user` | 依赖外部运行时；不可用 → `sandbox_unsupported` |

- `impl` 住 schema / config（`native` / `docker`）；`capabilities` 报本机可用实现与平台能力（自述面，供 UI 展示；**改名以避与协议握手 `probe` 撞名**）。
- 二进制与 ONNX 运行时同路（#20 先例）：**入世只有 Rust 源码 + Cargo 清单**，`target/` 编译产物走 `.worldignore`（宿主侧 ③）。

## exec

```
exec(bag) -> { exit_code, stdout, stderr, truncated, duration_ms, artifacts? }
```

- **一次性**：一次 `exec` 一进程（或一容器），无 stdin 交互；cwd = `bag.workspace_root`（由 #27 解析后 bag 传，见 #41）；#28 / #29 反向调 #25 时把 `workspace_root` 随 args 透传（本插件服务**不读投影**，D8）；临时目录住宿主侧 ③、结束清理。
- 超时 / 超内存 / 超输出 → 杀**进程树**（native：Job Object / 进程组；docker：`--rm` + kill）。
- **stdout / stderr 截断**到 `output_max`；明文密钥不出现在审计（密钥经 #24 句柄，只注入进程环境，不落 args）。
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
| `list` | `pattern?` / `limit?` | `{ paths:[…], truncated }` | ✓ |
| `grep` | `pattern` / `glob?` / `limit?` | `{ matches:[{path,line,text}], truncated }` | ✓ |
| `write` | `data` / `create?` / `expected_hash?` | `{ bytes_written, created, hash }` | ✗ |
| `replace` | `old` / `new` / `replace_all?` / `expected_hash?` | `{ replaced, added, removed, patch }` | ✗ |

- **强制点在 #25，不在 #28**：#25 独立做 `realpath(path)` 并与 `workspace_root` 比对（防符号链接逃逸），取「#28 声明的 `caps.fs.*` ∩ 当前 `tier` 范围」后执行；#28 的「区内 / 区外」归类只是**声明**，越界由 #25 拒 `fs_denied` 或（`severe` 档）由 #26 判升级。
- **原子读改写**：`replace` 在**一次 `fsop` 内**完成 read→比对→write（不给 #28 留 TOCTOU 窗口）；`old` 未命中或非唯一 → `edit_conflict`；`expected_hash`（可选）= 调用方读到的旧内容哈希，不符 → `edit_conflict`（乐观并发）。
- **v1 只做文本**：命中二进制 / 超 `output_max` → `binary_unsupported` / `too_large`（**S1 服务侧资产面**就位后再支持二进制，见 `host.md` §五 宿主扩展面）。
- **与 `exec` 同一套资源上限与隔离**（native / docker 共用）；`fsop` 不启动子进程，由 #25 在受限上下文内直接触盘。
- **`caps.grant`**：与 `exec` 同规——批准后一次性放宽**本次** `fsop`（绑定 `call_id`），校验 `call_id` / 范围 / 档位后放行；不进世界、不可重放为常设权限。
- **#28 不直接触盘**：#28 的四个工具全部映射为 `fsop`（`read`→`read`、`edit`→`replace` / `write`、`glob`→`list`、`grep`→`grep`），结果由 #25 回、#28 结构化后回 #27。

## 网络

- **本插件不设默认网络策略、不做网络决策**；`caps.net` 由调用方（工具声明）+ 四档给，实现层**尽力执行**（docker：`--network none`；native：net namespace 尽力）。
- 实验簇（chrono-agent-graph）的「默认无网」是**该实验自己的策略**，不落本插件默认。

## 平台与失败

- v1：**win32 + linux**；mac 后补（`sandbox_unsupported`）。Docker 可用时优先（若配置）。
- 失败码：`sandbox_unsupported`（平台 / 运行时不可用）、`sandbox_setup_failed`、`timeout`、`oom`、`output_truncated`（非错，标记）、`fs_denied`（越界被拒）。
- `fsop` 追加：`bad_path`（形态非法）、`path_not_found` / `not_a_directory`、`edit_conflict`（`replace` 的 `old` 未命中 / 非唯一 / `expected_hash` 不符）、`too_large` / `binary_unsupported`（v1 文本限制）。

## 跨插件登记

- **#26 guard**：本插件**强制** fs 范围（4 档做进沙箱）+ 消费一次性 `caps.grant`；guard **独占**「危险 / 越界」定义（`schema/guard.json`），本插件不读该定义、只按 caps 与 grant 强制。
- **#40 ui-composer / #2 config**：档位全局、由输入框写 `config.permission`；档位由调用方入口 term 读投影后经 bag 传入（本插件服务**不读投影**，D8）；改档 = 改 config（数据热生效，进程不动）。
- **#28–31**：工具声明 `caps`、pin 本插件；换 `impl` 不改工具。
- **#28 `tool-fs`（版本提升：被提升方，**S2 已展开**）**：① **结构化操作执行面 `fsop`** 已定（见上，`sandbox:["exec","fsop","capabilities"]`）；② `severe` 的 fs 范围与「区外」判据已对齐（**区内 / 区外读写都经本插件强制**，区外 = 超出默认范围）；③ 二进制经 **S1 `host.asset.*`**（`host.md` §五 宿主扩展面），未就位时回 `binary_unsupported`。提出方登记见 `plugins/tool-fs/DESIGN.md`。
- **#20 embedding**：二进制 / 编译产物走 `.worldignore` 的先例。
- **#41 workspace**：`bag.workspace_root` 为 cwd（非 pin）。
