# sandbox（隔离执行门面）

隔离执行能力的**受保护身份**与**公开门面**（**Rust**）：保留原公开方法名，把算法委派给三个提供方插件
（`sandbox-policy` 档位 / 授权判定、`sandbox-exec` 执行体生命周期、`sandbox-fs` 文件系统操作）——
一次性 `exec` + 可轮询后台任务 `exec_start` / `exec_poll` / `exec_kill` + 持久会话 `session_close` +
结构化文件操作 `fsop` + 四档 fs/net 强制 + 一次性 `caps.grant` 消费。
本插件**只强制、永不发升级**：越界一律结构化拒绝（`fs_denied` / `net_denied`），升级判定归 `guard`、审批往返归编排面。
消费方**零改动**：仍只经 `sandbox` 能力类调用，门面每方法至多一跳（`exec` / `exec_start` / `fsop` 先向
`sandbox-policy` 解析判定并随 bag 的 `resolved` 字段下传，再转发执行方）。

- 能力类：`sandbox`；方法：`exec` / `exec_start` / `exec_poll` / `exec_kill` / `session_close` / `fsop` / `capabilities`（`capabilities` 避与协议握手 `probe` 撞名）。
- 命令：无。`pins`：无（服务不读投影，所需世界数据随 bag 传入）。
- `needs`：`sandbox-policy` / `sandbox-exec` / `sandbox-fs`（各 `{"mode":"one"}`）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 实现语言：Rust（门面：帧循环 + 反向调用；算法在三个提供方；`target/` 与二进制走宿主侧依赖缓存）。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `sandbox.exec` 140000 / `sandbox.exec_poll` 130000 / `sandbox.fsop` 70000——宿主按声明覆盖 30s 缺省等待上限，长命令与大批量 fsop 不被截断；门面在 `sandbox.exec` / `sandbox.fsop` 上先向 `sandbox-policy` 解析（≤5000）再转发执行方（≤130000 / ≤60000），故门面上界严格大于两跳之和；门面反向等待上限抬到 140000，保证不先于提供方超时。

## 方法契约

### `exec(bag)`

```jsonc
// bag（两种形状都接受：顶层或嵌在 bag.args）
{ "cmd": "cmd.exe", "args": ["/c", "echo hi"], "env": { "K": "V" }, "cwd": "C:\\ws\\sub",
  "tier": "severe", "workspace_root": "C:\\ws", "caps": { /* … */ },
  "sandbox_tiers": { /* 本身份数据世代 body */ }, "grant": { "call_id": "…" } }
// 会话形态（bag 带 session_id + command）：在常驻 shell 内执行，cd / env 跨调用延续
{ "session_id": "t1", "command": "Set-Location src", "session_shell": { "cmd": "powershell.exe",
  "args": ["-NoProfile","-NoLogo","-NoExit","-Command","-"], "syntax": "powershell" }, … }
```

- 一次性进程、无 stdin 交互；cwd 取 `bag.cwd`（缺省 = `bag.workspace_root`）；`env` 键值表注入子进程环境。
  `bag.cwd` 落在工作区内即放行，区外须当前档 fs 读范围为 `full`（如 `auto` 档），否则 `fs_denied`——这是 exec 的路径强制点。
- 超时 / 超限杀**整树**；stdout / stderr 各自超 `output_max` 时按**头 70% + 尾 30%** 保留，中间插入 `… [N bytes omitted] …` 标记并记 `omitted_bytes`，两端夹到合法 UTF-8 边界（`truncated:true`，标记非错）。
- 返回 `{ exit_code, stdout, stderr, truncated, omitted_bytes, combined, combined_truncated, duration_ms, code? }`；`combined` 是按到达顺序合并的 stdout / stderr 分块（保交错），`code ∈ timeout / oom / cpu_exceeded / procs_max` 仅在超限被杀时出现。
- 前置失败走协议 `error` 帧：`sandbox_unsupported` / `sandbox_setup_failed` / `fs_denied` / `net_denied` / `bad_args`。

### 会话与任务（`exec_start` / `exec_poll` / `exec_kill` / `session_close`）

- `exec_start`：带 `session_id` 时在常驻 shell 内起一条命令，否则起一次性进程；立即回 `{task_id}`。
- `exec_poll({task_id, cursor?, wait_ms?})` → `{output, next_cursor, running, exit_code, code, truncated, dropped_bytes, tail}`：
  自 `cursor`（字节偏移）取增量输出；输出头部顺序追加供游标读，溢出进尾部环形（`tail`，结束时并入最终结果），两头之外丢弃并记 `dropped_bytes`。
- `exec_kill({task_id})`：一次性任务杀整树，会话命令杀会话。`session_close({session_id})` 回收会话。
- **会话**：常驻 shell（Windows `-NoExit -Command -` 行式 REPL，命令经 base64 + `Invoke-Expression` 送入；Linux `bash -s` + POSIX 哨兵帧 `printf '<marker>%s\n' "$?"`），支持多行且 `cd` / env 延续。
  会话与任务都是**进程内存活对象**：不落世界、不进 chain、不跨宿主重启；重启后由调用方透明重建。
  空闲 TTL 30 分钟、容量 16；会话被占用（命令在跑）时新命令回 `session_busy`；命令 `exit N` 终止 shell 时回该退出码并在下条命令透明重建。
  会话输出为 stdout / stderr 合并（现有结果面 `stderr` 为空），且只强制执行墙钟超时（不按命令累计 CPU）。

### `fsop(bag)`

```jsonc
{ "op": "read", "path": "src/main.rs", "args": { "offset": 0, "limit": 200 },
  "caps": { "fs": { "read": "workspace", "write": "workspace" } },
  "tier": "severe", "workspace_root": "C:\\ws", "sandbox_tiers": { /* … */ }, "grant": { "call_id": "…" } }
```

返回 `{ ok:true, op, result }` | `{ ok:false, code, message }`。

| op | args | result |
| --- | --- | --- |
| `stat` | — | `{ exists, is_dir, size, mtime }`（`mtime` 取自文件系统，不参与确定性保证） |
| `read` | `offset?` / `limit?` / `preview?` | `{ text, total_lines, start_line, end_line, lines_returned, has_more, next_offset, content_truncated, truncated, binary, preview }` |
| `list` | `pattern?` / `base?` / `depth?` / `tree?` / `ignore?` / `limit?` | `{ paths:[…], truncated, skipped_count }`；`tree:true` 时改回 `{ tree:[{name,path,type,children?}], truncated, skipped_count }`（相对 `base`、字典序） |
| `grep` | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `before?` / `after?` / `glob?` / `base?` / `ignore?` / `limit?` | `{ matches:[{path,line,text,before?,after?,count?}], truncated, skipped:{binary,too_large,unreadable}, mode, base, glob, ignore, ignored_paths, ignored_paths_truncated, hint }` |
| `write` | `data` / `create?` / `exclusive?` / `expected_hash?` | `{ bytes_written, created, hash }` |
| `replace` | `old` / `new` / `replace_all?` / `expected_hash?` | `{ replaced, added, removed, bytes_written, patch }` |

- 强制点在 `sandbox-fs`：`canonicalize`（解析符号链接 / junction / reparse point、归一 `\\?\` 前缀）后与 `workspace_root` 前缀比对（Windows 大小写不敏感），取「声明 `caps.fs.*` ∩ 当前档」后执行。
- `replace` 在**一次调用内**完成 read→比对→写（临时文件 + rename），`old` 未命中 / 非唯一 / `expected_hash` 不符 → `edit_conflict`；**非唯一时 `message` 附带命中总数与行号（最多 20 处），模型据此收窄锚点或改用 `replace_all`，无需再读一遍**。行尾自适应：文件为 CRLF 而 `old` 用 LF（或反之）时按文件风格转换后再匹配 / 替换，混合行尾不改写；`bytes_written` 回传原子重写后的整份文件字节数。
- `write` 的 `exclusive:true`：目标已存在即 `edit_conflict`（`create_new` 语义，写锁内检查 + rename 前复核），供新建只发一次 `write`。
- `grep` 支持字面与手写简易正则（无外部依赖、确定性）：交替 `|`、分组 `()`、量词 `*`/`+`/`?`/`{n}`/`{n,}`/`{n,m}`、锚点 `^`/`$`、字符类 `[...]`、类简写 `\d`/`\D`/`\w`/`\W`/`\s`/`\S`、转义元字符与 `\n`/`\t`/`\r`；不支持反向引用 / 环视 / 非贪婪量词。**`args.mode`（`literal` / `regex`）缺省自动**：含强正则信号（`|` / 类简写 / 转义元字符 / `{n}`）的模式按正则处理、其余按字面；`args.regex:true` / `mode:"literal"` 可显式强制。**真语法错误（未闭合分组或类 / 悬空量词 / 尾反斜杠 / 未知转义 / `max<min`）一律回 `bad_args`，不静默退化为字面匹配**。
- `grep` 另支持 `ignore_case`（模式与命中行同做 **Unicode casefold**：Default Case Folding，表驱动、随源码入世；**不含** NFC/NFD 规范化，组合形 / 分解形不互相匹配）、`files_only`（每文件只回一条：首命中行号/文本 + `count`）、`before` / `after`（命中前后上下文行数，各自夹到 ≤20，命中项附 `before` / `after` 数组）；`limit` 缺省 200（`files_only` 下为文件数上限）。二进制 / 超 `output_max` / 不可读的文件被跳过，数量在 `skipped` 回报。
- `list` / `grep` 的 `ignore`：条目按「文件名 / 整路径 / 任一路径段」匹配，遍历时命中目录整棵剪枝（`target` 即剪掉 `target/`）；含 `/` 的条目按相对路径 glob。
- `read` 行号统一 1 基：`start_line` / `end_line` 标出窗口首末行，`text` 为原始文本（不带行号前缀，**保留文件原有行尾**）；`has_more` 为真时用 `next_offset`（0 基）续读；`content_truncated` 为真表示内容被 `output_max` 按字节截断（末行可能不完整、文件其余不可再读）。
- `read` / `grep` 命中二进制（NUL 字节）→ `binary_unsupported`；**`read` 另对「无 NUL 但非合法 UTF-8」的伪二进制（如 GBK / UTF-16）回 `binary_unsupported`，不再静默 lossy 解码**；**`read` 超 `output_max` 返回截断内容 + `truncated:true`（非错）**；`too_large` 只用于 `write` / `replace` 输入或既有文件超限。权限不足归 `permission_denied`。

### `capabilities()`

自述本机可用实现与平台能力：`{ platform, implementations:[{impl,available,isolation,features|reason}], default_impl, enforcement, text:{casefold:{unicode}}, linux? }`（`isolation` 为各后端真实隔离档，`native: partial` / `docker: container`；`linux` 为 Linux 隔离层运行态明细 `{landlock_abi,cgroup_v2,seccomp,namespaces}`（`namespaces` 为实际施加的种类数组，**不含 pid**），非 Linux 为 `null`；`enforcement.exec_fs` 在 Linux 有 landlock 时为 `landlock`，`enforcement.net` 按 namespaces → seccomp → declaration 取实际最强者；`text.casefold.unicode` 为 `grep.ignore_case` 所用 casefold 表的 Unicode 版本）。
health 探针名声明为 `sandbox.capabilities`（宿主健康判定实际走协议级 `probe`/`pong`）。

## 四档 fs/net

档位映射表住**本身份数据世代 body**（`bag.sandbox_tiers`，由调用链最上游入口 term 读出随 bag 传入；热改 = 数据换代）。
包内 `tools/default-body.json` 是默认 body 的结构化形态，`execute/tiers.rs` 有同形内建兜底，测试保证两者一致。

| 档 | fs 读 | fs 写 | net |
| --- | --- | --- | --- |
| `auto` | full | full | all |
| `severe` | workspace | workspace | limited |
| `review` | workspace | none | none |
| `deny` | none | none | none |

- 实际放行 = 「工具声明 `caps` ∩ 当前档范围」；越界 `fs_denied` / `net_denied`；未知 / 缺失档 fail-closed 全拒。
- `caps.grant`（批准后一次性）：绑定 `{call_id, op, path, tier, expires}`，`deny` 档不放宽，`paths` 空视为**不适用**，`fs` 未声明即不额外放宽；校验通过才放宽**本次**；不进世界、不可重放为常设权限。消费记录驻进程内存（容量上限 + TTL）。

## 失败码

- 通用：`sandbox_unsupported` / `sandbox_setup_failed` / `timeout` / `oom` / `cpu_exceeded` / `procs_max` / `output_max` / `output_truncated`（标记非错）/ `fs_denied` / `net_denied`。
- fsop 追加：`bad_path` / `bad_args` / `path_not_found` / `not_a_directory` / `not_a_file` / `edit_conflict` / `too_large` / `binary_unsupported` / `io_error`。

## 平台口径与已知限制

- **win32 原生（第一公民，已全测）**：Job Object 管进程树 / 内存 / CPU 时间 / 活跃进程数；`CREATE_SUSPENDED` 起进程 → 挂 job → `ResumeThread`；超时 / 超限 `TerminateJobObject` 杀整树。输出管道读 + 截断。
  - **已知限制**：宿主 / 测试进程若处于不允许 breakaway 的 job，`AssignProcessToJobObject` 失败，回落 `taskkill /T /F`（树杀仍成立，内存 / CPU / 进程数上限不强制）。
  - **已知限制**：**exec 的 fs 写范围不做 OS 级强制**（AppContainer / 低完整性后置）。exec 的 fs 范围强制由 `fsop` 进程内校验承担，真 OS 隔离由 Docker 后端兜底。`deny` 档仍直接拒 `exec`。
  - **子进程环境**：`env_clear` 后只注入最小白名单（`PATH` / `SystemRoot` / `TEMP` / `TMP` / `PATHEXT` / `ComSpec` 等系统变量，
  以及 `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` / `APPDATA` / `LOCALAPPDATA` / `PROGRAMDATA` / `USERNAME` / `PSModulePath` 等
  用户位置变量——它们不是密钥，缺失会让 git / npm / python 找不到配置与缓存）+ `args.env`；宿主其余环境（含密钥）不继承。
- **linux 原生（WSL 已验证）**：独立进程组（`process_group(0)`，超时 / 信号 `killpg` 杀整组）+ namespaces（user / mount / net）+ landlock fs 白名单 + cgroup v2 资源上限 + seccomp syscall 过滤（各层不可用即回退 / 缺席）+ 输出截断 / 合并 / 任务 / 会话与 Windows 同口径。
  - **landlock**：按当前档把读 / 写限制到 `workspace_root` 子树；系统只读目录（`/usr` `/lib` `/bin` `/etc` `/dev` `/proc` 等）另加只读规则（否则动态链接的解释器起不来），`/dev/null` 例外可写。**不**处理 EXECUTE 位（避免目录遍历被逐级拦截），故「可执行但不可读」的文件不属本层防御。内核未启用 landlock 时不施加，`capabilities.features` 如实缺席。
  - **cgroup v2**：每次执行建 `chrono-<id>/`，写 `memory.max` / `pids.max`，子进程 `pre_exec` 迁入；内存超限由内核 OOM 杀并据此判 `code:"oom"`，进程数超限表现为 fork 失败。`cpu.ms` 是**总** CPU 时间，与 `cpu.max` 的速率语义不同，仍由 `RLIMIT_CPU` 强制（`cpu.max` 显式写 `max`）。无 cgroup v2 / 不可写时回退 `RLIMIT_AS` / `RLIMIT_NPROC`，`capabilities` 如实标注哪些生效。
  - **seccomp**：`PR_SET_NO_NEW_PRIVS` + `PR_SET_SECCOMP(FILTER)`。基础集合禁 `mount` / `umount2` / `ptrace` / kexec / 内核模块 / `reboot` / `pivot_root` / `swapon` / `swapoff`；`caps.net == none` 且**未**上 net namespace 时，`socket` 域仅放行 `AF_UNIX` / `AF_NETLINK`，挡住 `AF_INET` / `AF_INET6` / `AF_PACKET`。只支持 x86_64（其他架构如实不声称），**宁可少禁**。
  - **namespaces**：`unshare(CLONE_NEWUSER | CLONE_NEWNS [| CLONE_NEWNET])`，写 uid / gid 映射并把 `/` 挂载传播改私有；`caps.net == none` 时进新 net namespace（只剩 `lo`，无外网）。可用性经 `fork` 探针在运行态验证。**不含 pid namespace**：进入新 pid ns 需在 `pre_exec` 再 `fork`，直接子进程会变转发者，破坏 `SIGXCPU` / OOM 的信号归类；本层优先保证资源判定准确，pid 视图隔离如实缺席。
  - **任务与会话**：`exec_start` 无 `session_id` 时走一次性进程（与前台 `exec` 同一套隔离与树杀）；有 `session_id` 时起常驻 `bash -s` 会话，命令经 stdin + POSIX 哨兵帧，`cd` / env 跨命令延续，`exit N` 回该码并在下条命令透明重建。会话施加进程组树杀 + cgroup（内存 / 进程数）+ landlock（按创建档 fs 范围）+ seccomp 基础集；**不施命名空间**（会话跨不同 caps 的命令复用，绑定某一 net ns 会误伤后续命令），无 cgroup 时只回退内存 rlimit（不设 `RLIMIT_NPROC`，避免 root 全局计数误杀）。
  - **已知限制**：`RLIMIT_NPROC` 是**每真实用户**的全系统计数，root 下易被既有进程占满，故仅一次性进程在无 cgroup 时兜底；`workspace` 档下工作区外写入一律 `EACCES`（含 `/tmp` 临时文件；`/dev/null` 例外）；user namespace 只映射 `0 → 0`，工作区文件若属其他 uid 会不可读写；会话不含命名空间隔离。
  - **未实现（如实缺席于 `capabilities.features`）**：pid namespace。
  - **syscall 绑定手写**（`execute/linux.rs` / `landlock.rs` / `cgroup.rs` / `seccomp.rs` / `namespaces.rs` 的 `extern "C"`，不引 libc）：保持零第三方运行时依赖、离线可构建。
  - **验证**：仅在本机 WSL Ubuntu（内核 6.18，landlock ABI 7、cgroup v2 可写、seccomp 过滤可用、user / mount / net namespace 可用）跑 `cargo test`，**非裸机**；`bash plugins/sandbox-exec/tools/wsl-test.sh test`。
- **mac 原生**：未实现，`exec` 诚实返回 `sandbox_unsupported`。`fsop` 为进程内校验，跨平台可用。
- **docker 后端**：检测 `docker version`（3s 上限）；不可用 → `capabilities` 报 unavailable、`impl=docker` 时 `sandbox_unsupported`。容器调用代码（`--network` / `--read-only` / `--user` / bind mount / `--memory` / `--pids-limit`；`args.env` 以 `-e <键>` 转发、值不进 argv）已实现，但**本仓库开发机无 docker，未在本机验证**；`limited` 网络白名单未实现，一律回落 `--network none`。
- **grant 防伪造**：授权面（`sandbox-policy`）只做机械校验（绑定 / 一次性 / 档位 / 过期）；v1 的 bag 与模型 args 未做 provenance 隔离，伪造 grant 的防线依赖上层（tools / tool-fs 的可信字段边界 + 审批闸）。
- **计时口径**：`duration_ms` 用系统单调时钟（`Instant`）。exec 本身是效果、结果进审计，单调计时是运行态观测、不落世界、不影响可回放。
- **grant 消费记录**驻进程内存：服务重启后不保留（grant 短时、绑定单次调用，跨重启重放不构成常设权限）。

## 运行

```sh
npm test                                  # 门面：cargo test（协议 / manifest 形状）
# 提供方各自：cd plugins/sandbox-policy; cargo test / cd plugins/sandbox-exec; cargo test / cd plugins/sandbox-fs; cargo test
# Linux 原生 exec：bash plugins/sandbox-exec/tools/wsl-test.sh test   # 在 WSL 里隔离拷贝 + cargo test
# 档位判定：cd plugins/sandbox-policy; cargo test（四档 / caps 钳制 / grant 一次性）
# 文本 casefold 表刷新：python plugins/sandbox-fs/tools/gen-casefold.py
```

## 委派关系

- 判定：`sandbox-policy.resolve`（纯档位 / caps 判定）与 `sandbox-policy.consume`（一次性 grant 消费）。
- 执行：`sandbox-exec`（进程 / 会话）+ `sandbox-fs`（fsop），均 `needs:{"sandbox-policy":one}`。
- 门面：`sandbox` 保留公开方法名，逐方法委派；`fsop` / `exec` / `exec_start` 先解析判定再转发。

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` / `Cargo.toml` /
`README.md` / `schema/` / `execute/` 随源码入世。
