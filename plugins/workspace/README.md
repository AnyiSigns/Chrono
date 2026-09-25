# workspace（工作区）

工作区（工作目录）清单本体服务（**Rust**）：清单**已出世界** + 路径校验 + 系统原生目录选择器 `pick` +
在文件管理器中打开 `reveal` + 最近打开（本机 ③）。不做会话列表与分组渲染（归 `ui-sidebar`）、
不做文件读写（归 `tool-fs`）、不 watch 目录、不追踪改名。

- 能力类：`workspace`；方法：`list` / `read` / `pick` / `add` / `remove` / `reveal`。
- 命令：无（命令面在 `ui-sidebar`）；`pins`：无（服务读写自有存储，不读投影）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`durable`（④ 不可重算；清单跨代存活、进备份、只按身份消失回收）；`exclusive: ["data"]`。
- 最近打开在本机 ③，可重算。

## 逐字段判定（定义 / 判定 vs 运行记录）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 字段 | 判定 | 理由 |
| --- | --- | --- |
| `version` | 运行记录（出世界） | 存储格式版本；回滚不该带；判定不从世界读 |
| `workspaces[].id` | 运行记录（出世界） | 工作区标识属用户清单；回滚不该带 |
| `workspaces[].name` | 运行记录（出世界） | 展示名属用户清单 |
| `workspaces[].path` | 运行记录（出世界） | 工作区根路径：`workspace_root` 由 chat 装配 interpret bag 时经 `eff` 问 owner；门禁运行时读 owner，不从世界读 |
| ③ `recent`（`state/plugins/workspace/recent.json`） | ③ 可重算（不进 ④） | 本机便利性，删了可重算 |

**结论**：清单无留在世界的字段；留在世界的是 `Identity.schema`（数据契约 def）。
- 实现语言：Rust（源码 + `Cargo.toml` + `Cargo.lock` 入世，`target/` 与二进制走宿主侧依赖缓存）。

## 方法契约

服务**不读投影、不写世界**：清单读写全在自有持久存储（④）；调用方（`ui-sidebar` 命令入口 term）
只传槽体 / `thread_id`，服务返回结果值。**输入槽清理由调用方经 `input` 服务承担**（本服务不再构造清槽计划）。

### `read`

```jsonc
// args 忽略 → { version, workspaces: [ { id, name, path } ] }
```

- 回整份清单；存储为空时回 `{ version: 1, workspaces: [] }`。

### `list`

```jsonc
// args 忽略 → [{ id, name, path, missing }]
```

- 从自有存储取清单，逐路径 stat：不存在 / 非目录为 `true`（stat 失败按 `missing` 收口，不阻塞其它项）。
- `name` 缺省回落 `basename(path)`。空清单 → `[]`（health 探针名 `workspace.list` 即依赖此收口）。

### `pick`

```jsonc
// args 忽略（{}）→ { "path": "C:\\ws" } | { "cancelled": true }
```

- 系统原生目录选择器（win32 `IFileOpenDialog` + `FOS_PICKFOLDERS`）；成功把路径前插记入
  `CHRONO_PLUGIN_STATE/recent.json`。
- 无图形会话 / 选择器不可用 → 协议错误 `picker_unavailable`（不提供路径输入框）。

### `add`

```jsonc
{ "slot": { "kind": "workspace.add", "workspace": "<新 id>", "name?": "…", "path": "…" },
  "thread_id": "_main" }
```

- 槽体也可直接作 args 本身（`kind` 为 `workspace.add`）。
- 校验序：**realpath 解析**（win32 解 junction / reparse point，归一 `\\?\` 前缀）→ 存在 / 是目录 / 可读 →
  按 realpath 去重（win32 大小写不敏感）。
- 通过 → 清单追加 `{id,name,path}`（`name` 缺省 `basename`）并**即时写自有存储**（边跑边追加），
  返回 `{ok:true,workspace}`。
- 失败 → 清单不变，返回 `{ok:false,error[,workspace]}`。
- 结构性非法 args（缺槽 / 缺 id / 缺 path / 槽 kind 不符）→ 协议错误 `bad_args`。
- **清槽由调用方承担**：`ui-sidebar` 在本方法返回后经 `input.clear` 清本线程槽（无论成败）。

### `remove`

```jsonc
{ "slot": { "kind": "workspace.remove", "workspace": "<目标 id>" }, "thread_id": "_main" }
```

- 清单删该项并即时写自有存储，返回 `{ok:true,workspace,removed}`。
- 目标 id 不在清单 → 幂等成功（清单不变），`removed:false`。

### `reveal`

```jsonc
// args = { "workspace": "<id>" }（按 id 在自有存储的清单里解析 path）
// → { "ok": true } | { "ok": false, "error": "reveal_failed" }
```

- win32 `explorer` / mac `open` / 其它 `xdg-open`（cfg 门控）；**纯动作：不写存储、不经槽**。
- 成功记 ③ 最近打开（本机便利性，不参与重放）。

## 存储引擎与落点（自写）

- ④ 落点：`CHRONO_PLUGIN_DATA/workspace.jsonl`，单文件追加日志（每条一次 append + `sync_all`，换行收尾）。
  记录 `{t:'body', run, body}`；启动重放取最后一条 body，末行半写撕裂 / 坏行跳过（fail-open）。
- **边跑边追加**：`add` / `remove` 即时写一条记录，不攒批；同内容重复写幂等短路；每条记录盖回合 id（`run`）。
- **存量不搬**：存储从空开始，旧世界世代留在链上但不再被读。
- **清理责任**：自写存储；owner 退役时宿主按身份回收删除 `state/data/workspace/`，无需额外清理方法。

## 错误码

| 码 | 触发 | 收口 |
| --- | --- | --- |
| `path_not_found` | 目录不存在 | `{ok:false,error}`（清单不变） |
| `not_a_directory` | 路径是文件 | 同上 |
| `permission_denied` | 不可读 | 同上 |
| `workspace_exists` | realpath / id 重复（带既有 id） | 同上 |
| `picker_unavailable` | 无图形会话 / 选择器缺失 | 协议错误帧 |
| `reveal_failed` | 文件管理器拉起失败 | `{ok:false,error}` |
| `bad_args` | 结构性非法 args | 协议错误帧 |
| `unknown_method` / `unresolved_cap` | 未知方法 / 能力类 | 协议错误帧 |

## 最近打开（本机 ③）

- 位置：`state/plugins/workspace/recent.json`，形状 `{ "recent": ["<path>", …] }`。
- 按最近优先、上限 10、前插去重、无时间戳（顺序即 LRU）；`pick` / `reveal` 成功时更新。
- 丢失只影响便利性：不砖化、不进世界、不参与哈希。

## 默认清单

`tools/default-body.json` 是**模板**（占位符 `${WORKSPACE_ID}` / `${WORKSPACE_NAME}` / `${WORKSPACE_PATH}`）；
`tools/seed-default-body.mjs` 把宿主根 realpath 作为首个工作区，id 由 realpath 的 sha256 前 12 位**确定性派生**
（同根重复执行命中内容幂等，不取时间 / 随机），**离线直接追加写入 owner ④ 追加日志**
（宿主须已停；宿主启动时由服务重放读回）。

## 平台与已知限制

- **pick**：win32 走 `IFileOpenDialog`（COM / Shell）；其它平台诚实报 `picker_unavailable`。
  对话框本身是 GUI，无法在自动化测试中驱动，故「打开对话框」与「方法逻辑」分层（`Picker` trait），
  测试覆盖逻辑层（成功记最近打开 / 取消 / 不可用），win32 实现只保证编译与调用路径。
- **reveal**：`explorer` 有时以非 0 退出码返回，但 spawn 成功即视为已拉起（只判拉起失败）。
- realpath 归一 `\\?\` 前缀后入库；同一目录经 junction / 大小写 / 分隔符差异仍判重。
- `add` 的 realpath 判定以调用时文件系统为准；入库后目录改名 / 移动 = 该工作区失效（`list` 标 `missing`）。

## 运行

```sh
npm test                                  # cargo test（协议 / store / list / add / remove / pick / reveal / recent / 确定性）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（seed → 离线 seed 清单 → start → 物化编译 → 协议直连 add → verify/replay）
node tools/seed-default-body.mjs --root <宿主根目录>   # 预置默认清单（离线，宿主须已停）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `Cargo.lock` / `README.md` / `schema/` / `execute/` 随源码入世。
