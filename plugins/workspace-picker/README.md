# workspace-picker（工作区选择器）

工作区 OS 集成原语（**Rust**）：系统原生目录选择器 `pick` + 在文件管理器中打开 `reveal` +
最近打开（本机 ③）。不做工作区清单与路径校验（归 `workspace`）、不做文件读写（归 `tool-fs`）。

- 能力类：`workspace-picker`；方法：`pick` / `reveal`。
- 命令：无（命令面在 `ui-sidebar`）；`pins` / `needs`：无（纯 OS 调用，不读投影、不写世界）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`（仅本机 ③ 缓存 `recent.json`，可重算）。

## 方法契约

服务**不读投影、不写世界**：一切输入随 `args` 传入，服务只出 OS 效果并返回结果值。

### `pick`

```jsonc
// args 忽略（{}）→ { "path": "C:\\ws" } | { "cancelled": true }
```

- 系统原生目录选择器（win32 `IFileOpenDialog` + `FOS_PICKFOLDERS`）；成功把路径前插记入
  `CHRONO_PLUGIN_STATE/recent.json`。
- 无图形会话 / 选择器不可用 → 协议错误 `picker_unavailable`（不提供路径输入框）。

### `reveal`

```jsonc
// args = { "workspace": "<id>", "workspaces": [ { "id", "path" }, … ] }
// → { "ok": true } | { "ok": false, "error": "reveal_failed" }
```

- 本服务无 `needs`、不持清单，按 `workspace` id 在调用方随 `workspaces` 传入的清单里解析目标 path；
  解析不出 → 协议错误 `bad_args`。
- win32 `explorer` / mac `open` / 其它 `xdg-open`（cfg 门控）；**纯动作：不写存储、不经槽**。
- 成功记 ③ 最近打开（本机便利性，不参与重放）。

## 错误码

| 码 | 触发 | 收口 |
| --- | --- | --- |
| `picker_unavailable` | 无图形会话 / 选择器缺失 | 协议错误帧 |
| `reveal_failed` | 文件管理器拉起失败 | `{ok:false,error}` |
| `bad_args` | 结构性非法 args / id 不在清单 | 协议错误帧 |
| `unknown_method` / `unresolved_cap` | 未知方法 / 能力类 | 协议错误帧 |

## 最近打开（本机 ③）

- 位置：`state/plugins/workspace-picker/recent.json`，形状 `{ "recent": ["<path>", …] }`。
- 按最近优先、上限 10、前插去重、无时间戳（顺序即 LRU）；`pick` / `reveal` 成功时更新。
- 丢失只影响便利性：不砖化、不进世界、不参与哈希。

## 平台与已知限制

- **pick**：win32 走 `IFileOpenDialog`（COM / Shell）；其它平台诚实报 `picker_unavailable`。
  对话框本身是 GUI，无法在自动化测试中驱动，故「打开对话框」与「方法逻辑」分层（`Picker` trait），
  测试覆盖逻辑层（成功记最近打开 / 取消 / 不可用），win32 实现只保证编译与调用路径。
- **reveal**：`explorer` 有时以非 0 退出码返回，但 spawn 成功即视为已拉起（只判拉起失败）。

## 运行

```sh
npm test                                  # cargo test（协议 / pick / reveal / recent）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `Cargo.lock` / `README.md` / `execute/` 随源码入世。
