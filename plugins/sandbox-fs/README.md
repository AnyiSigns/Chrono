# sandbox-fs（文件系统操作）

沙箱链的**文件系统操作提供方**（Rust）：结构化 `fsop` 六 op（`stat` / `read` / `list` / `grep` /
`write` / `replace`）与范围强制。范围判定来自判定提供方 `sandbox-policy`（随调用 bag 的 `resolved`
字段注入）；**强制点在本身份**：`canonicalize`（解析符号链接 / junction / reparse point、归一 `\\?\`
前缀）后与 `workspace_root` 前缀比对，取「声明 caps ∩ 当前档」后执行。

- 能力类：`sandbox-fs`；方法：`fsop` / `capabilities`（`capabilities` 只回本插件的文本匹配口径片段，完整结果由 `sandbox` 门面合并）。
- 命令：无。`pins`：无（服务不读投影，tier / caps / workspace_root / sandbox_tiers 全由调用方随 bag 传入）。
- `needs`：`sandbox-policy`（档位 / 授权判定）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 实现语言：Rust（源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧依赖缓存）。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `sandbox-fs.fsop` 60000。

## 方法契约

### `fsop(bag)`

```jsonc
{ "op": "read", "path": "src/main.rs", "args": { "offset": 0, "limit": 200 },
  "caps": { "fs": { "read": "workspace", "write": "workspace" } },
  "tier": "severe", "workspace_root": "C:\\ws", "sandbox_tiers": { /* … */ },
  "grant": { "call_id": "…" }, "resolved": { /* sandbox-policy.resolve 输出 */ } }
```

返回 `{ ok:true, op, result }` | `{ ok:false, code, message }`。

| op | args | result |
| --- | --- | --- |
| `stat` | — | `{ exists, is_dir, size, mtime }`（`mtime` 取自文件系统，不参与确定性保证） |
| `read` | `offset?` / `limit?` | `{ text, total_lines, start_line, end_line, lines_returned, has_more, next_offset, content_truncated, truncated, binary }` |
| `list` | `pattern?` / `base?` / `ignore?` / `limit?` | `{ paths:[…], truncated }`（相对 `base`、字典序） |
| `grep` | `pattern` / `mode?` / `ignore_case?` / `files_only?` / `before?` / `after?` / `glob?` / `base?` / `ignore?` / `limit?` | `{ matches:[{path,line,text,before?,after?,count?}], truncated, skipped:{binary,too_large,unreadable} }` |
| `write` | `data` / `create?` / `exclusive?` / `expected_hash?` | `{ bytes_written, created, hash }` |
| `replace` | `old` / `new` / `replace_all?` / `expected_hash?` | `{ replaced, added, removed, bytes_written, patch }` |

逐 op 语义与 `sandbox` 原口径一致（行号 1 基、`read` 保留原行尾、`grep` 大小写折叠、`replace`
一次调用内 read→比对→写、CRLF 自适应、`write.exclusive` 等）。失败码与 `sandbox` 原口径一致。

## 运行

```sh
npm test    # Windows：cargo test（fsop 六 op / 路径强制 / casefold / 任务）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `README.md` / `schema/` / `execute/` 随源码入世。
