# #41 `workspace`（工作区）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 41 / `workspace` |
| 语言 | **Rust**（`pick` 系统原生目录选择器 / `reveal` 文件管理器 / realpath 判定走原生 OS API，如 `rfd` 一类）。与 #20/#25 同路：源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧 ③ 依赖缓存 |
| 职责 | 工作区（工作目录）本体：列表**进世界** + 路径校验 + 原生目录选择器 `pick` + 在文件管理器中打开 `reveal` + 最近打开（本机 ③） |
| 依赖 | pins 无；`<-` 16（pins：`workspace.list` / `pick` / `add` / `remove` / `reveal` 的入口 term 发 eff；`list` 读 `ctx.ids.workspace.body`、`add` / `remove` 读 `#1` 槽——**均由 #16 入口 term 读投影后经 args 传入，本插件服务不读投影**，D8）；11（**版本提升**：会话 schema 加 `workspace_id`）；1（**版本提升**：槽 kind 新增 `workspace.add` / `workspace.remove` 与字段 `workspace` / `name` / `path`，被提升方见 `plugins/input/DESIGN.md`）；28–31 / 25 的执行根由**入口 term 读投影解析**后经 #33/#27 **bag 传 `workspace_root`**（不 pin 本插件，见下「执行根交接」） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["workspace"]`，`methods: {workspace:["list","pick","add","remove","reveal"]}` |
| 命令 | 无（命令面在 #16 `ui-sidebar`） |
| schema | `schema/workspace.json`（工作区列表进世界；最近打开在本机 ③，不在 body） |
| 机制 | 见下「包契约 / 数据契约 / 方法契约 / 执行根交接 / 最近打开 / 错误码 / 跨插件登记」 |
| 边界 | 不做：会话列表与分组渲染（归 16）/ 文件读写（归 28）/ 白名单外访问 / 目录内容监听（不 watch）/ 会话跨区移动（后置）/ 目录改名追踪 / **附件文件选择（在浏览器 `#40`，走 `<input type="file">`，只需字节、不需路径；本插件只做要绝对路径的目录 `pick` 与 `reveal`）** |
| 验收 | 1) 列表进世界、可回放；2) `add` 校验存在 / 是目录 / 可访问 / 按 realpath 去重，失败有结构化错误且**槽仍被清**；3) 会话 `workspace_id` 创建即钉死（不可改）；4) `pick` 取消 / 失败 / 无图形会话三收口明确；5) 目录缺失时 `list` 标记 `missing`、不阻塞已有会话；6) 换本插件实现不改 16；7) 执行根只经 bag 传，工具不直接依赖本插件 |
| 状态 | 细节设计（2026-09-19）：写路径（服务出计划）、执行根交接（bag 传）、首启与最近打开（seed 预置 + ③）三项已定 |

> **为什么必须是插件**：`pick` / `reveal` 是平台相关 IO（原生目录选择器 / 文件管理器），且工作区列表要进世界（会话引用它才能回放一致）——两者都不是纯数据能表达的。

## 包契约 `plugin.json`

```jsonc
{ "identity": "workspace",
  "schema": "schema/workspace.json",
  "implements": ["workspace"],
  "methods": { "workspace": ["list", "pick", "add", "remove", "reveal"] },
  "pins": {},
  "start": "node execute/main.js",     // 平台 IO（原生选择器 / 文件管理器），必须起服务
  "protocol": "1",
  "restart": {}, "health": {},
  "state": "recomputable",
  "members": [
    { "kind": "execute", "path": "execute/" },
    { "kind": "schema",  "path": "schema/" }
  ],
  "commands": [] }
```

- 无 `terms/`：命令面全在 #16（入口 term 读槽 / args 后 eff 到本插件）。
- `state: recomputable`：body 进世界（真源）；最近打开在本机 ③（可重算、可 GC）。

## 数据契约 `schema/workspace.json`

```json
{
  "title": "workspace（工作区列表）",
  "description": "工作区列表进世界、可回放。每项 { id, name, path }：id 由客户端生成（opaque 短 id）；path = 绝对 realpath；name 缺省 = basename(path)；按 realpath 去重、创建即钉死（目录改名 / 移动 = 该工作区失效，走 missing）。无时间戳（列表顺序 = 追加顺序）。",
  "type": "object",
  "required": ["version", "workspaces"],
  "additionalProperties": true,
  "properties": {
    "version": { "type": "integer" },
    "workspaces": { "type": "array", "items": { "type": "object" } }
  }
}
```

- 白名单子集无 `oneOf` / `$ref`，`items` 的元素形状写在 `description`，由**写入端**（#41 计划 / seed）保证（宿主 v1 不校验身份数据）。
- 默认 body（seed 预置，同 #2 config 口径）：`{ version: 1, workspaces: [ { id, name, path: <宿主根 realpath> } ] }`（宿主侧生成 id、取 realpath）。首启零摩擦、可直接开聊；列表为空时 #16 只显示 [+ 添加工作目录]。

## 方法契约

| 方法 | 触发（#16 命令） | 输入 | 输出 / 计划 |
| --- | --- | --- | --- |
| `list` | `workspace.list`（无参） | args 由 #16 入口 term 读 `ctx.ids.workspace.body` 后传入（本插件服务不读投影，D8） | `[{ id, name, path, missing }]`；`missing` = 逐路径 stat 结果（不存在 / 非目录） |
| `pick` | `workspace.pick`（无参） | — | `{ path }` / `{ cancelled: true }`；调原生选择器，成功记 ③ 最近打开 |
| `add` | `workspace.add`（无参，读槽） | 槽 `{kind:'workspace.add', workspace, name, path}` 由 #16 入口 term 读 `ctx.ids.input.body.slots` 后经 args 传入 | 校验 → 计划【batch：写 workspace 新一代 + 清槽 + extern】；失败 → 计划【batch：清槽 + extern{ok:false,error}】 |
| `remove` | `workspace.remove`（无参，读槽） | 槽 `{kind:'workspace.remove', workspace}` 由 #16 入口 term 读 `ctx.ids.input.body.slots` 后经 args 传入 | 计划【batch：写 workspace 新一代（删该项）+ 清槽 + extern】 |
| `reveal` | `workspace.reveal`（args `{workspace}`） | workspace id | 解析 path → 打开文件管理器；`{ok:true}` / `{ok:false,error}`（**不写世界、不经槽**） |

- **写类走槽、命令无参**（§1.2 第 2 条）：`add` / `remove` 的载荷先写入 #1 输入槽，命令无参、入口 term eff 到本插件；**#16 入口 term 读 `ctx.ids.input.body.slots` 后把槽体经 args 传入**，本插件据 args 构造写计划（本插件服务**不读投影**，服务无写通道，D8）。
- **`reveal` 不走槽**：它是纯动作（无世界写），故走命令 `args`（argsSchema `{workspace}`）；若走槽则无计划清槽、会污染下一回合。
- 命令面（`workspace.list` / `pick` / `add` / `remove` / `reveal`）在 #16 声明；本插件只声明能力类方法。

### `add` 的校验与去重

1. **realpath 解析**：绝对化 + `realpath.native`（win32 解 junction / reparse point）——**不是 realpath 不算同一目录**。
2. **存在 / 是目录 / 可读**：缺失 → `path_not_found`；存在但非目录 → `not_a_directory`；不可读 → `permission_denied`。
3. **去重**：realpath 已在列表 → `workspace_exists`（extern 带既有 `workspace` id，UI 可直接定位）。
4. 通过 → body 追加 `{ id, name, path }`（`name` 缺省 basename）→ 计划写回 + 清槽。

### 写计划形状（服务返回，宿主填 `id` / `by` / `ref` / `expect_pos`）

```jsonc
// add 成功：一条 batch 原子写 workspace 新一代 + 清槽；extern 回执给 #16
{ "$directives": [
  { kind: "write", op: "batch", args: { ops: [
      { op: "put",     args: { body: /* 合并后的 workspace body */ } },
      { op: "add_gen", args: { id: "workspace", payload: { $n: 0 }, pins: {}, sig: { $n: 0 } } },
      { op: "put",     args: { body: /* 清槽：per-thread 键控——{ slots: { …其余键, "<thread_id>": { kind:"idle" } } }，只清本线程键（#1「清槽契约」） */ } },
      { op: "add_gen", args: { id: "input", payload: { $n: 2 }, pins: {}, sig: { $n: 2 } } }
  ] } },
  { kind: "extern", payload: { ok: true, workspace: "<新 id>" } }
] }
```

- `{"$n":k}` 指向**同一 batch 内更早**的 `put` 下标（0 基）：workspace body 在 0、idle body 在 2。
- `remove` 同形，只是 body 为「删除该项后」的列表；失败路径只保留清槽两条 + `extern{ok:false,error}`。

### 清槽契约（本插件计划内，与 #11 同规）

```jsonc
// per-thread 键控：只清本线程键，其余键不动（#1「清槽契约」）
{ op:'put',     args:{ body:{ slots:{ …其余键, "<thread_id>": { kind:'idle' } } } } },
{ op:'add_gen', args:{ id:'input', payload:{ $n:k }, pins:{}, sig:{ $n:k } } }
```

- `idle` body 恒定 ⇒ 该线程键的 `put` 命中 dup、不新增 def；只多一条 gen entry（同 #1）。清槽是 per-thread 键控（只清本线程键、不擦其他线程）。
- **失败路径也必须清槽**：`add` / `remove` 无论成败都返回含清槽的计划，否则残留的 `workspace.*` 槽会让下一回合 #11 判定「非法槽 kind」。
- **登记**：#1 现写「唯一写回者是 #11」已不完整——凡消费输入槽的写类命令，其终局计划都清槽（本插件即其一）。见下「跨插件登记」。

## 执行根交接（bag 传，已定）

- **解析点 = 入口 term**（#14 `chat` 的入口 term；服务不读投影，D8）：读投影 `ctx.ids.session.body`（`current` 会话 → `workspace_id`）→ `ctx.ids.workspace.body`（`workspaces[id].path`）→ 写入 `bag.workspace_root`，经 #33 传给 #27 `dispatch`。
- **工具侧**（#28–31 / 25）：只用 `bag.workspace_root`，并在使用时再校验存在（目录可能已删）→ 缺失即结构化失败 `workspace_missing`；**不读本插件投影、不 pin 本插件**；#28 / #29 反向调 #25 时把 `workspace_root` 随 args 透传（#25 服务**不读投影**，D8）。
- 为什么不让工具各自投影读：三份解析逻辑会漂移；为什么不让工具 eff `workspace.root`：每次调用多一跳、且 #28–31 都要 pin #41。
- `workspace_id` **创建即钉死**（#11 会话 schema），故执行根在一次会话内稳定；换工作区 = 新建会话（跨区移动后置）。

## 最近打开（宿主侧 ③）

- 位置：`state/plugins/workspace/recent.json`（宿主**插件 ③ 目录**能力，与 #21 向量索引同路）。
- 形状：`{ "recent": ["<path>", …] }`，**按最近优先**、上限 10；`pick` / `reveal` 成功时前插去重。无时间戳（顺序即 LRU）。
- 用途：原生选择器的初始目录、UI 快速访问；**③ 丢失只影响便利性**，不砖化、不进世界、不参与哈希。

## 错误码（结构化，extern 回 UI）

| 码 | 触发 | UI 收口（#16） |
| --- | --- | --- |
| `path_not_found` | 目录不存在 | 行内 danger |
| `not_a_directory` | 路径是文件 | 行内 danger |
| `permission_denied` | 不可读 | 行内 danger |
| `workspace_exists` | realpath 重复 | 定位到既有分组 |
| `picker_unavailable` | 无图形会话 / 选择器缺失 | 「系统选择器不可用」+ 指引用 CLI / 启动参数指定目录（**不提供路径输入框**） |
| `reveal_failed` | 文件管理器拉起失败 | 行内 danger |

## 跨插件登记

- **版本提升：提出方** —— 要求 #1 `input` 升一代：槽 kind 新增 `workspace.add` / `workspace.remove`，字段新增 `workspace`（id）/ `name` / `path`；并修正「唯一写回者 #11」为「消费该槽的写类命令的终局计划」（本插件是新增写回者）。被提升方登记见 `plugins/input/DESIGN.md`。
- **#16 命令面**新增 `workspace.add` / `workspace.remove` / `workspace.reveal`（`workspace.list` / `pick` 已有）；依赖行 `-> 41` 覆盖全部五条。
- **#11 会话**：`workspace_id` 创建即钉死（已登记在 `plugins/session/DESIGN.md`）。
- **#27 tools**：新增「解析 `bag.workspace_root`」职责（本插件不 pin 它、它不 pin 本插件；纯投影读）；#27 解析后经 bag 下传，#28 / #29 反向调 #25 时随 args 透传（各服务均**不读投影**，D8）。
