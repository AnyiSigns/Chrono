# tool-fs（文件工具）

结构化文件读写服务（**Rust**）：四个工具 `read` / `edit` / `glob` / `grep`，路径与范围归类在本插件，
**所有触盘经反向帧 `port.call` 到 `sandbox.fsop`**——本插件不直接触盘、不写世界、不绕过 guard / sandbox。

- 能力类：`tool-fs`；方法：`describe` / `invoke`（类名 = 身份名）。
- 命令：无（`commands: []`）。
- `pins`：`sandbox`（所有触盘经其 `fsop` 隔离 / 四档强制）、`host`（二进制字节通道 `host.asset.put/get` 的 pin 声明）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 实现语言：Rust（源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧依赖缓存）。

## 四个工具

`describe(bag)` 一次回报四个工具（四要素 / `argsSchema` / `caps` / `idempotent` / `render`）：

| 工具 | 幂等 | `caps.fs` | args | 结果 |
| --- | --- | --- | --- | --- |
| `read` | ✗ | read | `path` / `offset?` / `limit?` | `{text, total_lines, truncated}` |
| `edit` | ✗ | write | `path` / `old` / `new` / `replace_all?` | `{created?, replaced, bytes_written, added, removed, patch}` |
| `glob` | ✗ | read | `pattern` / `path?` / `ignore?` / `limit?` | `{paths, truncated}` |
| `grep` | ✗ | read | `pattern` / `glob?` / `path?` / `ignore?` / `limit?` | `{matches, truncated}` |

- 文件可变，四个工具都标 `idempotent:false`（不进宿主结果缓存）。
- `edit` 两种形态：`old` 非空 ⇒ 精确替换（未唯一命中回 `edit_conflict`，`replace_all:true` 全部替换）；
  `old` 为空且文件不存在 ⇒ 新建（先 `stat` 判定），文件已存在回 `edit_conflict`；新建写带空内容的
  `expected_hash`，收口 `stat` 与 `write` 之间被并发写入非空内容的竞态（不符回 `edit_conflict`）。
- `render`：`read` = 一行（`form:"line"`，不可展开）；`edit` = 默认收缩卡片 + `detail:{kind:"diff"}`；
  `glob` / `grep` = 近乎透明卡片（`tone:"ghost"`）+ `detail:{kind:"paths"|"matches"}`。
  `detail` 只声明渲染器种类，数据由渲染器按 `kind` 从结果取（`{result.*}` 模板只用于 `summary`）。

## `invoke` 与 fsop 映射

`bag = {tool, args, workspace_root, tier, caps, grant?, ignore?, sandbox_tiers?}`：

| 工具 | fsop op | args |
| --- | --- | --- |
| `read` | `read` | `offset?` / `limit`（缺省 2000） |
| `edit`（`old` 非空） | `replace` | `old` / `new` / `replace_all?` |
| `edit`（`old` 空、文件不存在） | `write` | `data=new` / `create:true` / `expected_hash=空内容`（前一步 `stat` 判定） |
| `glob` | `list` | `pattern` / `base=path?` / `ignore` / `limit`（缺省 200） |
| `grep` | `grep` | `pattern` / `glob?` / `base=path?` / `ignore` / `limit`（缺省 100） |

- `glob` / `grep` 的 `path?` 映射 `fsop.base`；`ignore` 原样传。
- 忽略表优先级：工具 `args.ignore` > 调用方 `bag.ignore`（本身份数据世代 body）> 内置兜底
  （`.git` / `node_modules` / `target` / `__pycache__` / `.venv`，与 `schema/tool-fs.json` 一致）。
- `tier` / `workspace_root` / `grant` / `sandbox_tiers` 原样透传；`caps` 的资源上限沿用调用方声明或 schema 缺省。
- `sandbox` 的错误（`fs_denied` / `edit_conflict` / `binary_unsupported` / `too_large` / `path_not_found` 等）
  **原样透传**（不吞、不改写）；结果面 `{ok:true,result}` / `{ok:false,error:{code,message}}`。

## 路径与范围归类（本插件独有职责）

- 相对路径以 `workspace_root` 为基准；绝对路径（含区外）同样合法；`..` 按词法规范化、不直接判错。
- 形态非法（空串 / NUL / 控制字符 / 平台非法字符 / Windows 保留设备名 / ADS `file:stream` / 尾随点或空格）
  → `bad_path`（机械拒、不触盘，与 sandbox 同口径或更严）。
- 本插件做**词法**归类（区内 / 区外）并据此声明 `caps.fs.*`（区内 `workspace` / 区外 `full`）；
  **realpath 解析、符号链接逃逸判定与强制点唯一在 `sandbox.fsop`**——本插件不直接触盘，归类只是声明。
- 相对路径缺 `workspace_root` → `workspace_missing`；绝对路径不需要 `workspace_root` 仍可派发。
- 区外不由本插件判升级：本插件只声明「区外 + 读 / 写」，是否弹卡归 `guard`；批准后的一次性 `caps.grant`
  由调用方随 bag 传入 → 本插件**透传**给 `sandbox.fsop` 放行本次。

## 大小与二进制

- 文本读写：UTF-8；`read` 默认行窗口（`offset` / `limit`），单次输出受 `output_max` 约束，超限截断并标 `truncated`（标记，非错）。
- v1 文本路径完整；命中二进制 → `binary_unsupported`。
- `host.asset.put/get` 是 pin 声明：**契约就位、v1 未启用**（本插件暂无二进制字节通道需求）；后续二进制读写走该通道。

## 已知限制与对齐说明

- **`glob` 顺序**：`sandbox.fsop.list` 返回**路径字典序**（确定性遍历），本插件与设计口径一致保持字典序：
  `mtime` 不在 `fsop.list` 结果里、排序需额外 `stat` 且时间不参与确定性保证，回放要求结果确定。
- **`edit.bytes_written`**：`fsop.replace` 只回 `{replaced, added, removed, patch}`，不回 `bytes_written`；
  替换分支由本插件按 `new` 的 UTF-8 字节数合成（与新建分支 `fsop.write` 的 `bytes_written` 同义）。
- **`edit` 新建的 diff**：`fsop.replace` 已自算并回 `added` / `removed` / `patch`，替换分支原样透传；
  只有新建分支由本插件合成「空文件 → new」的 patch。
- **区外新建**：新建分支先 `stat` 判存在（读权限）。若区外写只批了写类 `grant` 而未覆盖读，`stat` 可能被档位拒；
  此时本插件 fail-closed 回 `fs_denied`，不盲目覆盖既有文件。
- **`workspace_root` 目录已删**：本插件不直接触盘，无法自行探测；由调用方 / `sandbox` 侧的存在性检查兜底。

## 运行

```sh
npm test                       # cargo test（协议帧 / describe 四工具 / invoke→fsop 映射 / 路径归类 / 错误与 grant 透传）
node tools/e2e-smoke.mjs       # 宿主装配 E2E（pack → seed → start → 两身份 loaded → 直连服务协议驱动工具 + stop → verify/replay）
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `Cargo.lock` / `README.md` / `schema/` / `execute/` 随源码入世。
