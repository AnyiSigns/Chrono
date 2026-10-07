# Chrono

Chrono 是一个**可复现的世界**框架：你选一个目录当"世界"，往里加入插件，然后通过 `chrono` 命令调用它们。
世界里的源码、数据、谱系都可回退、可复现、可审计。

框架只发布 **`@chrono/framework` 一个 npm 包**，不发布任何插件。

> 这是**给使用者**的文档。想了解插件怎么写，见 `docs/plugins.md`；想参与框架开发，见 `CONTRIBUTING.md`；工程规范见 `docs/coding.md`。

## 三个概念

| 角色       | 是什么     | 在哪                                                                               | 谁提供   |
| ---------- | ---------- | ---------------------------------------------------------------------------------- | -------- |
| **框架包** | 程序       | 本地安装（见「安装」）后得到 `chrono` 命令；发布后为 `npm i -g @chrono/framework`  | 框架作者 |
| **世界**   | 数据与配置 | 一个目录（**宿主根**），经 `chrono world create <路径> as <别名>` 登记为可引用世界 | 你       |
| **插件**   | 能力包     | 第三方 npm 包 / git 仓库 / 本地目录，经 `chrono plugin <世界> add` 加入            | 插件作者 |

要点：**框架包不含配置、不含插件**。世界就是**你运行 `chrono` 的那个目录**——它**不是**要 `npm init`
的 node 工程，空目录即可。卸载 / 升级框架包不影响世界里的数据。

## 安装

> **尚未发布到 npm registry**：`npm i -g @chrono/framework` 暂时不可用。先从框架源码本地安装。

在框架源码仓库（本仓库根目录）执行：

```
npm install                                   # 装构建依赖（含 tsc）
npm pack --pack-destination pack              # 触发 prepack 构建，产出 pack/chrono-framework-<版本>.tgz
npm i -g "./pack/chrono-framework-<版本>.tgz"  # 得到全局命令 chrono（<版本> 换成上一步的文件名）
chrono help
```

仍想用包名安装，等发布到 npm 后即可：`npm i -g @chrono/framework`。

## 快速上手

### 1. 选一个目录当世界（宿主根）并登记别名

随便一个目录，空目录、已有目录、当前目录都行。用 `world create` 初始化并登记一个别名，
之后任意目录都能按别名引用它：

```
chrono world create ./my-world as mine
chrono world ls          # { "worlds": [ { "alias": "mine", "root": ".../my-world", "running": false } ] }
```

世界引用 `<世界路径/别名>` 先按别名解析、未命中再按文件路径。`state/`（世界与运行落盘）、
`plugins/`（托管插件）会在使用时自动创建。

### 2. （可选）写世界的配置 `chrono.config.json`

放在世界根目录。**不写也能跑**（走内建默认）：

```json
{
  "protected_pins": ["sandbox", "guard", "secrets", "approval", "storage-sql", "storage-kv"]
}
```

- `protected_pins`：受保护身份名单；入世时删掉对它们的依赖绑定会被整批拒绝，防止存储 / 安全服务被静默摘除。
  **缺失即空集**（无受保护身份、守卫静默失效），宿主记一条 `protected_pins_unset` 运维告警——请显式配置。
- `ecosystem`（可选）：覆盖语言 / 工具链默认，例如 `{ "ecosystem": { "entry_extensions": ["mjs", "js"] } }`（配置键为 snake_case，非 camelCase）。
- 缺省语义：`ecosystem` 文件 / 键缺失 → 内建默认，零行为变化；`protected_pins` 缺失 → 空集 + 告警；形态非法 → 直接拒绝。
  也可用环境变量 `CHRONO_PROTECTED_PINS` / `CHRONO_ECOSYSTEM` 覆盖。

### 3. 加入插件

```
chrono plugin mine add ./my-plugin                # 本地目录（link 进来，可边写边热更）
chrono plugin mine add some-plugin                # npm 包名
chrono plugin mine add git+https://host/repo.git  # 远程 git 仓库（可选 --ref <分支/tag>）
```

**插件属于指定世界**：`add` 写进该世界的 `plugins/<name>` 并登记到它的 `state/plugins.json`，只入世这个世界。
要让另一个世界也有，就在那个世界里再 `add` 一次。

### 4. 起宿主

```
chrono world start mine
# { "ok": true, "root": "...", "pid": 12345, "call_timeout_ms": 30000, "start_wrapper": null, "watch": false }
chrono world start --all        # 起全部已登记世界的宿主
```

宿主是**后台守护进程**（关终端仍运行，世界只有一个写者）。运维日志在 `state/lifecycle.log`。
`--watch` 打开源码热更（`hot=auto` 的插件改动自动生效）。

### 5. 查看与调用

```
chrono world status mine        # 链头 + 已装载身份
chrono plugin mine ls           # 已登记插件（名字 / 身份 / hot）
chrono plugin mine info <插件>  # 插件身份 / active 世代 / 可用世代 / hot
chrono plugin mine commands     # 宿主知道的插件命令
chrono plugin mine <插件命令>   # 按插件声明调用（args 可传 JSON 或 @文件）
```

### 6. 升级 / 切版本 / 移除 / 停机

```
chrono plugin mine upgrade <name>     # 触发新代码世代（内容没变则 unchanged）
chrono plugin mine switch <name> 2    # 切换 active 世代（版本号 = 世代号或 payload 哈希）
chrono plugin mine remove <name>      # 退役：撤下暂存 + 撤销登记 + 世界里 retire
chrono world stop mine                # 优雅停机
```

## 多个世界与切换

一个目录 = 一个世界，可以有任意多个，彼此独立（各自的 `state/`、`plugins/`、写者锁、socket）。
用 `chrono world create <路径> as <别名>` 登记别名，之后任何命令都按 `<世界路径/别名>` 指定目标：

```
chrono world ls                     # 已登记世界（别名 / 路径 / 运行状态）
chrono world create ~/worlds/a as a
chrono world create ~/worlds/b as b
chrono world status a               # 世界 A
chrono world status ~/worlds/b      # 世界 B（直接给路径）
chrono world start --all            # 起全部世界的宿主
chrono world stop --all             # 停全部世界的宿主
```

- 不同世界可以**同时各起一个宿主**，互不干扰；同一世界同时只有一个宿主。
- 世界之间不共享数据，也没有"全局插件库"。
- 注册表是全局用户配置（Windows `%APPDATA%\chrono\worlds.json`，POSIX `$XDG_CONFIG_HOME|~/.config/chrono/worlds.json`，`CHRONO_WORLDS` 可覆盖）。

## 为什么没有端口

框架的通信全部走本地 IPC，不开 TCP 端口：

```
用户 / CLI / UI ──本地 socket──► 宿主进程 ──stdin/stdout 管道──► 插件服务进程
                 (Windows named pipe / POSIX unix socket)      (或 inproc / worker)
```

- **宿主 ↔ 客户端**：本地 socket，名字由世界路径摘要派生，所以每个世界不冲突，且以文件权限即鉴权。
- **宿主 ↔ 插件**：宿主把插件服务当子进程拉起，用管道收发协议帧（或在同进程 / worker 里直调）。
- **插件怎么被用**：你发起的调用经 `chrono` → 本地 socket → 宿主按 `needs` 路由 → 管道 → 插件服务 → 结果返回。
- 插件若**自己**要对外提供网络服务，是插件自己的事（可用 `exclusive:["port"]` 声明占用端口），框架不代管端口。

## 浏览器 / UI

宿主**不开 TCP 端口**，也不渲染网页（通信全走本地 socket 与进程管道）。因此框架自身不能直接给浏览器提供页面：
若需要浏览器 UI，必须由某个**插件**自己绑定端口、提供 HTTP 服务（可用 `exclusive:["port"]` 声明）。
**本仓库不包含任何此类 UI 插件。**

## 世界长这样

```
my-world/                  # 世界根（宿主根）
├── chrono.config.json     # 可选：这个世界自己的配置
├── plugins/               # chrono plugin add 托管进来的插件（只属于这个世界）
└── state/                 # 自动生成：world / data / blobs / assets / 审计 / 锁 / 日志
```

## 命令速查

文法：`chrono <域> <世界路径/别名> <子命令> [参数]`，域为 `world` / `plugin` / `term` / `help`。

| 命令                                                                                                                        | 作用                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `world ls` / `world create <路径> as <别名>` / `world remove <世界>`                                                        | 世界登记与查看                            |
| `world start <世界> \| --all [--watch] [--call-timeout-ms <ms>] [--start-wrapper <c>]`                                      | 起宿主（后台守护）                        |
| `world stop <世界> \| --all`                                                                                                | 停机                                      |
| `world status <世界>`                                                                                                       | 链头 + 已装载身份                         |
| `plugin <世界> add <来源> [--name <n>] [--ref <r>]`                                                                         | 加插件（本地路径 / npm 包名 / git 仓库）  |
| `plugin <世界> upgrade <插件>`                                                                                              | 触发新代码世代                            |
| `plugin <世界> switch <插件> <版本号>`                                                                                      | 切换 active 世代                          |
| `plugin <世界> remove <插件>`                                                                                               | 退役插件                                  |
| `plugin <世界> ls` / `plugin <世界> info <插件>`                                                                            | 列出 / 查看已登记插件                     |
| `world run <世界> <directives-json\|@文件>`                                                                                 | 提交 directives 跑一轮                    |
| `plugin <世界> commands`                                                                                                    | 列出插件命令                              |
| `world audit <世界> [filter]`                                                                                               | 只读审计面                                |
| `plugin <世界> <插件命令> [args-json]`                                                                                      | 按声明调用插件命令                        |
| `world seed <世界> [包...]` / `world pack <世界> <目录> --identity <id>` / `world verify\|replay\|unseeded\|compact <世界>` | 离线维护（世界入世 / 校验 / 重放 / 压缩） |
| `world gc <世界> assets\|blobs\|materialized`                                                                               | 回收无引用字节 / 目录                     |
| `term build <dir>`                                                                                                          | 编译插件 `terms.src/` 糖化判定            |
| `help`                                                                                                                      | 帮助                                      |

所有世界命令都按 `<世界路径/别名>` 指定世界（别名先按注册表解析，未命中再按文件路径）。

## 想自己写插件

插件是第三方自产的独立 npm 包，本框架不发布插件。怎么写、怎么组织成一套系统，见
[`docs/plugin-guide.md`](docs/plugin-guide.md)（教程）与 [`docs/plugins.md`](docs/plugins.md)（字段规范）。
