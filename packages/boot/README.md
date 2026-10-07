# boot：`chrono` CLI 薄壳

唯一入口的薄壳：**只做参数解析与转发**，不认识任何业务语义，不做判定、不碰世界。
命令是四域命名空间 `world` / `plugin` / `term` / `help`：`world` 管世界生命周期与离线维护，
`plugin` 按世界管插件并调用插件命令；`term` 构建；`help` 打说明。
世界引用 `<世界路径/别名>` 先按全局注册表别名解析、未命中再按文件路径。
随框架包发布为 `bin/chrono.mjs`（编译入口 `dist/packages/boot/main.js`），`boot` 为同指向别名。

## 用法

```
chrono <域> <世界路径/别名> <子命令> [参数]
# 源码直跑（开发）：
node packages/boot/main.ts <域> <世界路径/别名> <子命令> [参数]
```

世界生命周期与登记的别名由 `world` 子命令维护；其余命令都以世界为单位。
已知 flag 均支持 `--flag=value` 形态（首个 `=` 切分；`=` 形态下值可含 `--` 开头的字符，不被当下一枚 flag）。
`world start` 另收 `--call-timeout-ms <ms>`：效果调用超时（优先级 **CLI > `CHRONO_CALL_TIMEOUT_MS` > 30s 常量**），
生效值随 `{ok, root, pid, call_timeout_ms}` 一并打印；非法值退出码 1（`bad_call_timeout`）。
`world start` 还收 `--start-wrapper <cmd>`：把插件 `start` 包住的包装器命令（宿主侧最小沙箱形态，
优先级 **CLI > `CHRONO_START_WRAPPER` > 无**），生效值随 `start_wrapper` 打印；非法值退出码 1（`bad_start_wrapper`）。
`world start` 还收 `--watch`：打开源码 watcher（`hot=auto` 的插件跟随改动）。

## 命令

| 域   | 命令                                                                            | 说明                                                                                                             |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 世界 | `world ls`                                                                      | 列出已登记世界（别名 / 路径 / 运行状态）                                                                         |
| 世界 | `world create <路径> as <别名>`                                                 | 初始化目录并登记别名                                                                                             |
| 世界 | `world remove <世界>`                                                           | 注销别名（不删文件）                                                                                             |
| 世界 | `world start <世界> [--call-timeout-ms <ms>] [--start-wrapper <cmd>] [--watch]` | 起宿主（世界单写者，后台守护），就绪后打印 `{ok, root, pid, call_timeout_ms, start_wrapper, watch}`              |
| 世界 | `world start --all`                                                             | 起全部已登记世界的宿主（已运行则跳过），打印 `{ok, worlds}`                                                      |
| 世界 | `world stop <世界>` / `world stop --all`                                        | 停机：按启动序逆序摘除服务并并发 drain 后停机                                                                    |
| 世界 | `world status <世界>`                                                           | 链头与已装载身份清单                                                                                             |
| 世界 | `world run <世界> <directives-json\|@文件>`                                     | 提交 directives 跑一轮，打印 `{run, status, observations}`                                                       |
| 世界 | `world audit <世界> [filter-json\|@文件]`                                       | 只读审计面（`run` / `emitter` / `outcome` / `limit`）                                                            |
| 世界 | `world gc <世界> assets\|blobs\|materialized`                                   | 回收资产区 / 源码 CAS / 物化目录里世界无引用的字节                                                               |
| 世界 | `world seed <世界> [包路径...]`                                                 | 入世；缺省读 `state/plugins.json`（批量）                                                                        |
| 世界 | `world pack <世界> <目录> --identity <id>`                                      | 入世单个插件目录（手动 / 程序化；`--identity` 必须与包内 `plugin.json.identity` 一致，否则 `identity_mismatch`） |
| 世界 | `world verify <世界>`                                                           | 全量校验 journal                                                                                                 |
| 世界 | `world replay <世界>`                                                           | 全量重放并给出内容摘要                                                                                           |
| 世界 | `world unseeded <世界>`                                                         | 列出尚无数据世代的身份（不持锁，只读）                                                                           |
| 世界 | `world compact <世界> [--strict]`                                               | 压缩：追加快照 + 冷段归档 + 写基础世界                                                                           |
| 插件 | `plugin <世界> ls`                                                              | 列出已登记插件（名字 / 身份 / hot）                                                                              |
| 插件 | `plugin <世界> add <来源> [--name <n>] [--ref <r>]`                             | 取包（本地路径 / npm 包名 / git 仓库）→ 暂存 `plugins/<name>` → 登记 → 入世；宿主在跑时走 `plugin.ingest`        |
| 插件 | `plugin <世界> upgrade <插件>`                                                  | 对已暂存插件触发新代码世代（宿主在跑时走 `plugin.ingest`；否则离线 `seed`）                                      |
| 插件 | `plugin <世界> remove <插件>`                                                   | 退役：撤下暂存 + 撤销登记 + 世界 `retire`（宿主在跑时走 `plugin.remove`）                                        |
| 插件 | `plugin <世界> info <插件>`                                                     | 插件身份 / active 世代 / 可用世代（`seq` + `payload` + `code`）/ hot / 已装载世代                                |
| 插件 | `plugin <世界> switch <插件> <版本号>`                                          | 切换 active 世代；版本号 = 世代号（`seq`）或 payload 哈希；宿主在跑时写入站动词，否则离线持锁 `set_active`       |
| 插件 | `plugin <世界> commands`                                                        | 列出插件声明的命令                                                                                               |
| 插件 | `plugin <世界> <命令名> [args-json]`                                            | 按声明调用插件命令（`args` 也可用 `@文件`）                                                                      |
| 构建 | `term build <目录>`                                                             | 用内置 toolchain 编译 `terms.src/*.json` → `terms/*.json`                                                        |
| —    | `help`（或缺省）                                                                | 打印说明                                                                                                         |

- `world run` 的 `directives` 是内核形态的数组，例：
  `run '[{"kind":"write","request":{"id":"w1","op":"put","target":{"expect_pos":null},"args":{"body":["c",1]},"by":"cli"}}]'`。
- 框架保留名（单一真源 `host/common/framework-commands.ts`）：顶层只有 `world` / `plugin` / `term` / `help`；
  插件声明的命令名与 plugin 子命令动词（`ls` / `add` / `upgrade` / `remove` / `info` / `switch` / `commands`）
  冲突即入世拒 `reserved_command_name`——插件命令只经 `plugin <世界> <命令>` 调用。
- 参数含 `@` 前缀时从文件读 JSON（相对当前工作目录）。
- 输出：结果 JSON 走 stdout；错误消息走 stderr，退出码 1。
- **退出码**：用法错误与异常 → 1；`seed` / `pack` / `add` 有任一条目 `failed`、或 `verify` 报告 `ok:false` → 也**非 0**。

## 边界

- 不 import `host` 内部实现——只用 [`host/index.ts`](../host/index.ts) 公共面（含全局世界注册表）；
  `world start` 另起进程跑编译后的 `dist/packages/host/main.js`（源码直跑时为 `packages/host/main.ts`），不经 `startHost`。
- 不 import `toolchain`：`term build` 另起子进程跑编译后的 `dist/toolchain/build.js`。
- 不实现协议、不实现判定；连宿主的一切都在 `packages/client`，离线命令与插件管理是 `packages/host` 的出口。

## 本地检查

```
cd packages/boot
npm ci
npm run typecheck
npm run format:check
npm test             # test/main.test.ts：world / plugin / seed / pack / verify / replay / start 包装器冒烟
```
