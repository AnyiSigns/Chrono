# sandbox（隔离执行）

隔离执行服务（**Rust**）：一次性 `exec` + 结构化文件操作 `fsop` + 四档 fs/net 强制 + 一次性 `caps.grant` 消费。
本插件**只强制、永不发升级**：越界一律结构化拒绝（`fs_denied` / `net_denied`），升级判定归 `guard`、审批往返归编排面。

- 能力类：`sandbox`；方法：`exec` / `fsop` / `capabilities`（`capabilities` 避与协议握手 `probe` 撞名）。
- 命令：无。`pins`：无（服务不读投影，所需世界数据随 bag 传入）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 实现语言：Rust（源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧依赖缓存）。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `sandbox.exec` 130000 / `sandbox.fsop` 60000——宿主按声明覆盖 30s 缺省等待上限，长命令与大批量 fsop 不被截断（130000 高于调用方反向等待上界，避免正向超时先于反向等待击穿）。

## 方法契约

### `exec(bag)`

```jsonc
// bag（两种形状都接受：顶层或嵌在 bag.args）
{ "cmd": "cmd.exe", "args": ["/c", "echo hi"], "env": { "K": "V" },
  "tier": "severe", "workspace_root": "C:\\ws", "caps": { /* … */ },
  "sandbox_tiers": { /* 本身份数据世代 body */ }, "grant": { "call_id": "…" } }
```

- 一次性进程、无 stdin 交互；cwd = `bag.workspace_root`；`env` 键值表注入子进程环境。
- 资源上限：`timeout_ms` / `mem_mb` / `cpu_ms` / `output_max` / `procs_max`（取 caps，缺省回落档位 body 的 `defaults`）。
- 超时 / 超限杀**整树**；stdout / stderr 截断到 `output_max`（`truncated:true`，标记非错）。
- 返回 `{ exit_code, stdout, stderr, truncated, duration_ms, code? }`；`code ∈ timeout / oom / cpu_exceeded / procs_max` 仅在超限被杀时出现。
- 前置失败走协议 `error` 帧：`sandbox_unsupported` / `sandbox_setup_failed` / `fs_denied` / `net_denied` / `bad_args`。

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
| `read` | `offset?` / `limit?` | `{ text, total_lines, truncated, binary }` |
| `list` | `pattern?` / `base?` / `ignore?` / `limit?` | `{ paths:[…], truncated }`（相对 `base`、字典序） |
| `grep` | `pattern` / `glob?` / `base?` / `ignore?` / `limit?` | `{ matches:[{path,line,text}], truncated }` |
| `write` | `data` / `create?` / `expected_hash?` | `{ bytes_written, created, hash }` |
| `replace` | `old` / `new` / `replace_all?` / `expected_hash?` | `{ replaced, added, removed, patch }` |

- 强制点在**本插件**：`canonicalize`（解析符号链接 / junction / reparse point、归一 `\\?\` 前缀）后与 `workspace_root` 前缀比对（Windows 大小写不敏感），取「声明 `caps.fs.*` ∩ 当前档」后执行。
- `replace` 在**一次调用内**完成 read→比对→写（临时文件 + rename），`old` 未命中 / 非唯一 / `expected_hash` 不符 → `edit_conflict`。
- `grep` 支持字面与简易正则（`.` `*` `+` `?` `^` `$` `[...]` `\` 转义，无分组 / 交替）；默认仅在含正则专属元字符（`(` `[` `{` `|` `^` `$` `\`）时按正则，可用 `args.regex` 显式开关；遍历按路径字典序。
- `read` / `grep` 命中二进制（NUL 字节）→ `binary_unsupported`；**`read` 超 `output_max` 返回截断内容 + `truncated:true`（非错）**；`too_large` 只用于 `write` / `replace` 输入或既有文件超限。权限不足归 `permission_denied`。

### `capabilities()`

自述本机可用实现与平台能力：`{ platform, implementations:[{impl,available,features|reason}], default_impl, enforcement }`。
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
- fsop 追加：`bad_path` / `bad_args` / `path_not_found` / `not_a_directory` / `edit_conflict` / `too_large` / `binary_unsupported`。

## 平台口径与已知限制

- **win32 原生（第一公民，已全测）**：Job Object 管进程树 / 内存 / CPU 时间 / 活跃进程数；`CREATE_SUSPENDED` 起进程 → 挂 job → `ResumeThread`；超时 / 超限 `TerminateJobObject` 杀整树。输出管道读 + 截断。
  - **已知限制**：宿主 / 测试进程若处于不允许 breakaway 的 job，`AssignProcessToJobObject` 失败，回落 `taskkill /T /F`（树杀仍成立，内存 / CPU / 进程数上限不强制）。
  - **已知限制**：**exec 的 fs 写范围不做 OS 级强制**（AppContainer / 低完整性后置）。exec 的 fs 范围强制由 `fsop` 进程内校验承担，真 OS 隔离由 Docker 后端兜底。`deny` 档仍直接拒 `exec`。
  - **子进程环境**：`env_clear` 后只注入最小白名单（`PATH` / `SystemRoot` / `TEMP` / `TMP` / `PATHEXT` / `ComSpec` 等）+ `args.env`；宿主其余环境（含密钥）不继承。
- **linux / mac 原生**：namespace / seccomp / landlock 未实现，本机不可验证，`exec` 诚实返回 `sandbox_unsupported`（不交付假装隔离的代码）。`fsop` 为进程内校验，跨平台可用。
- **docker 后端**：检测 `docker version`（3s 上限）；不可用 → `capabilities` 报 unavailable、`impl=docker` 时 `sandbox_unsupported`。容器调用代码（`--network` / `--read-only` / `--user` / bind mount / `--memory` / `--pids-limit`；`args.env` 以 `-e <键>` 转发、值不进 argv）已实现，但**本仓库开发机无 docker，未在本机验证**；`limited` 网络白名单未实现，一律回落 `--network none`。
- **grant 防伪造**：本插件只做机械校验（绑定 / 一次性 / 档位 / 过期）；v1 的 bag 与模型 args 未做 provenance 隔离，伪造 grant 的防线依赖上层（tools / tool-fs 的可信字段边界 + 审批闸）。
- **计时口径**：`duration_ms` 用系统单调时钟（`Instant`）。exec 本身是效果、结果进审计，单调计时是运行态观测、不落世界、不影响可回放。
- **grant 消费记录**驻进程内存：服务重启后不保留（grant 短时、绑定单次调用，跨重启重放不构成常设权限）。

## 运行

```sh
npm test                                  # cargo test（协议 / fsop 六 op / exec / 四档 / grant / 档位数据驱动）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack → seed → start → 物化编译 → loaded → stop → verify/replay）
node tools/seed-default-body.mjs --root <宿主根目录>   # 预置档位映射数据世代（宿主已 start）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` / `Cargo.toml` /
`README.md` / `schema/` / `execute/` 随源码入世。
