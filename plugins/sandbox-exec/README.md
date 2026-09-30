# sandbox-exec（执行体生命周期）

沙箱链的**执行提供方**（Rust）：一次性 `exec` + 可轮询后台任务 `exec_start` / `exec_poll` /
`exec_kill` + 持久会话 `session_close`，以及四档 fs/net 强制的强制点。档位判定来自判定提供方
`sandbox-policy`（随调用 bag 的 `resolved` 字段注入；缺失时回落内建同源判定）。本插件**只强制、
永不发升级**：越界一律结构化拒绝（`fs_denied` / `net_denied`），升级判定归 `guard`、审批往返归编排面。

- 能力类：`sandbox-exec`；方法：`exec` / `exec_start` / `exec_poll` / `exec_kill` / `session_close` / `capabilities`。
- 命令：无。`pins`：无（服务不读投影，所需世界数据全由调用方随 bag 传入）。
- `needs`：`sandbox-policy`（档位 / 授权判定）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。实现语言：Rust（`target/` 与二进制走宿主侧依赖缓存）。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `sandbox-exec.exec` 130000 / `sandbox-exec.exec_poll` 130000。
- `capabilities`：自述平台 / 实现 / Linux 隔离层；`text`（文本匹配口径）由 `sandbox-fs` 提供，
  完整结果由 `sandbox` 门面合并。

## 方法契约

### `exec(bag)` / `exec_start(bag)`

```jsonc
{ "cmd": "cmd.exe", "args": ["/c", "echo hi"], "env": { "K": "V" }, "cwd": "C:\\ws\\sub",
  "tier": "severe", "workspace_root": "C:\\ws", "caps": { /* … */ },
  "sandbox_tiers": { /* … */ }, "grant": { "call_id": "…" }, "resolved": { /* sandbox-policy.resolve 输出 */ } }
// 会话形态（bag 带 session_id + command）：在常驻 shell 内执行，cd / env 跨调用延续
{ "session_id": "t1", "command": "Set-Location src", "session_shell": { "cmd": "powershell.exe",
  "args": ["-NoProfile","-NoLogo","-NoExit","-Command","-"], "syntax": "powershell" }, … }
```

- 一次性进程、无 stdin 交互；cwd 取 `bag.cwd`（缺省 = `bag.workspace_root`）；`env` 键值表注入子进程环境。
  `bag.cwd` 落在工作区内即放行，区外须当前档 fs 读范围为 `full`（如 `auto` 档），否则 `fs_denied`。
- 超时 / 超限杀**整树**；stdout / stderr 各自超 `output_max` 时按**头 70% + 尾 30%** 保留，中间插入
  `… [N bytes omitted] …` 标记并记 `omitted_bytes`，两端夹到合法 UTF-8 边界（`truncated:true`，标记非错）。
- 返回 `{ exit_code, stdout, stderr, truncated, omitted_bytes, combined, combined_truncated, duration_ms, code? }`。
- 前置失败走协议 `error` 帧：`sandbox_unsupported` / `sandbox_setup_failed` / `fs_denied` / `net_denied` / `bad_args`。

### `exec_poll` / `exec_kill` / `session_close`

`exec_poll({task_id, cursor?, wait_ms?})` → `{output, next_cursor, running, exit_code, code, truncated, dropped_bytes, tail}`；
`exec_kill({task_id})` 杀整树 / 杀会话命令；`session_close({session_id})` 回收会话。会话与任务都是**进程内存活对象**：
不落世界、不进 chain、不跨宿主重启；重启后由调用方透明重建（`session_missing`）。空闲 TTL 30 分钟、容量 16；
被占用时回 `session_busy`；`exit N` 终止 shell 时回该退出码并在下条命令透明重建。

## 平台口径与已知限制

与 `sandbox` 原口径一致（win32 Job Object / Linux process_group + namespaces + landlock + cgroup v2 +
seccomp；mac 未实现回 `sandbox_unsupported`；docker 后端检测可用性）。详见平台段落。

## 运行

```sh
npm test                                  # Windows：cargo test（协议 / exec / 任务 / 会话 / 四档）
bash plugins/sandbox-exec/tools/wsl-test.sh test   # Linux：WSL 内 cargo test（linux 原生 exec）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `README.md` / `schema/` / `execute/` 随源码入世。
