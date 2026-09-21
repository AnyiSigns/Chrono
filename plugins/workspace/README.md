# workspace（工作区）

工作区（工作目录）本体服务（**Rust**）：列表**进世界** + 路径校验 + 系统原生目录选择器 `pick` +
在文件管理器中打开 `reveal` + 最近打开（本机 ③）。不做会话列表与分组渲染（归 `ui-sidebar`）、
不做文件读写（归 `tool-fs`）、不 watch 目录、不追踪改名。

- 能力类：`workspace`；方法：`list` / `pick` / `add` / `remove` / `reveal`。
- 命令：无（命令面在 `ui-sidebar`）；`pins`：无（服务不读投影，所需世界数据随 args 传入）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`（body 进世界是真源；最近打开在本机 ③，可重算）。
- 实现语言：Rust（源码 + `Cargo.toml` + `Cargo.lock` 入世，`target/` 与二进制走宿主侧依赖缓存）。

## 方法契约

服务**不读投影、无写通道**：当前 workspaces body、输入槽体与 `thread_id` 全由调用方（`ui-sidebar` 命令入口 term）
读 `ctx` 后随 args 传入；服务只返回结果值或**写计划** `{"$directives":[…]}`。

### `list`

```jsonc
// args = 当前 workspaces body（也可包一层 { body: <body> }）
{ "version": 1, "workspaces": [ { "id": "…", "name": "…", "path": "…" } ] }
// → [{ id, name, path, missing }]
```

- `missing` = 逐路径 stat：不存在 / 非目录为 `true`（stat 失败按 `missing` 收口，不阻塞其它项）。
- `name` 缺省回落 `basename(path)`。args 缺失 / 空 body → `[]`（health 探针名 `workspace.list` 即依赖此收口）。

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
  "slots": { "slots": { "_main": { "kind": "workspace.add" }, "other": { "kind": "chat.message" } } },
  "body": { "version": 1, "workspaces": [ /* 当前列表 */ ] },
  "thread_id": "_main" }
```

- 槽体也可直接从 `slots.slots[thread_id]` 取（或 args 本身即槽体）。
- 校验序：**realpath 解析**（win32 解 junction / reparse point，归一 `\\?\` 前缀）→ 存在 / 是目录 / 可读 →
  按 realpath 去重（win32 大小写不敏感）。
- 通过 → 计划【batch：`put` 合并后 body（追加 `{id,name,path}`，`name` 缺省 `basename`）+
  `add_gen(workspace)` + `put` 清槽（整份 slots、只清本线程键）+ `add_gen(input)`】+ `extern{ok:true,workspace}`。
- 失败 → 计划【清槽两条（`put` + `add_gen(input)`）+ `extern{ok:false,error[,workspace]}`】；
  **无论成败都清槽**（否则残留槽会让下一回合判定「非法槽 kind」）。
- 结构性非法 args（缺槽 / 缺 id / 缺 path / 槽 kind 不符）→ 协议错误 `bad_args`，不构造计划。

### `remove`

```jsonc
{ "slot": { "kind": "workspace.remove", "workspace": "<目标 id>" },
  "slots": { "slots": { … } }, "body": { … }, "thread_id": "_main" }
```

- 计划【删该项的新 body + `add_gen(workspace)` + 清槽 + `add_gen(input)`】+ `extern{ok:true,workspace,removed}`。
- 目标 id 不在列表 → 幂等成功（body 不变、命中 `dup` 短路），`removed:false`。

### `reveal`

```jsonc
// args = { "workspace": "<id>", "path": "<目标路径>" }（path 缺失时按 workspace id 在 body 里解析）
// → { "ok": true } | { "ok": false, "error": "reveal_failed" }
```

- win32 `explorer` / mac `open` / 其它 `xdg-open`（cfg 门控）；**纯动作：不写世界、不经槽**。
- 成功记 ③ 最近打开（本机便利性，不参与重放）。

## 写计划形状

```jsonc
{ "$directives": [
  { kind: "write", request: { op: "batch", args: { ops: [
      { op: "put",     args: { body: /* 合并后的 workspace body */ } },
      { op: "add_gen", args: { id: "workspace", payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
      { op: "put",     args: { body: /* 清槽：per-thread 键控 */ } },
      { op: "add_gen", args: { id: "input",     payload: { $n: 2 }, sig: { $n: 2 }, pins: {} } }
  ] } } },
  { kind: "extern", payload: { ok: true, workspace: "<新 id>" } }
] }
```

`{"$n":k}` 指向**同一 batch 内更早**的 `put` 下标（0 基）；`request` 包裹是宿主计划通道方言。

## 错误码

| 码 | 触发 | 收口 |
| --- | --- | --- |
| `path_not_found` | 目录不存在 | extern 失败计划（槽仍被清） |
| `not_a_directory` | 路径是文件 | 同上 |
| `permission_denied` | 不可读 | 同上 |
| `workspace_exists` | realpath 重复（extern 带既有 id） | 同上 |
| `picker_unavailable` | 无图形会话 / 选择器缺失 | 协议错误帧 |
| `reveal_failed` | 文件管理器拉起失败 | `{ok:false,error}` |
| `bad_args` | 结构性非法 args | 协议错误帧 |
| `unknown_method` / `unresolved_cap` | 未知方法 / 能力类 | 协议错误帧 |

## 最近打开（本机 ③）

- 位置：`state/plugins/workspace/recent.json`，形状 `{ "recent": ["<path>", …] }`。
- 按最近优先、上限 10、前插去重、无时间戳（顺序即 LRU）；`pick` / `reveal` 成功时更新。
- 丢失只影响便利性：不砖化、不进世界、不参与哈希。

## 默认 body

`tools/default-body.json` 是**模板**（占位符 `${WORKSPACE_ID}` / `${WORKSPACE_NAME}` / `${WORKSPACE_PATH}`）；
`tools/seed-default-body.mjs` 把宿主根 realpath 作为首个工作区，id 由 realpath 的 sha256 前 12 位**确定性派生**
（同根重复执行命中幂等短路，不取时间 / 随机），经 `boot run` 提交一条原子 batch。

## 平台与已知限制

- **pick**：win32 走 `IFileOpenDialog`（COM / Shell）；其它平台诚实报 `picker_unavailable`。
  对话框本身是 GUI，无法在自动化测试中驱动，故「打开对话框」与「方法逻辑」分层（`Picker` trait），
  测试覆盖逻辑层（成功记最近打开 / 取消 / 不可用），win32 实现只保证编译与调用路径。
- **reveal**：`explorer` 有时以非 0 退出码返回，但 spawn 成功即视为已拉起（只判拉起失败）。
- realpath 归一 `\\?\` 前缀后入库；同一目录经 junction / 大小写 / 分隔符差异仍判重。
- `add` 的 realpath 判定以调用时文件系统为准；入库后目录改名 / 移动 = 该工作区失效（`list` 标 `missing`）。

## 运行

```sh
npm test                                  # cargo test（协议 / list / add 全路径 / remove / pick / reveal / recent / 确定性）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（seed → start → 物化编译 → 协议直连 add → 落账 → verify/replay）
node tools/seed-default-body.mjs --root <宿主根目录>   # 预置默认 body（宿主已 start）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `Cargo.lock` / `README.md` / `schema/` / `execute/` 随源码入世。
