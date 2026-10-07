# boot：`chrono` CLI 薄壳

唯一入口的薄壳：**只做参数解析与转发**，不认识任何业务语义，不做判定、不碰世界。
`start` 拉起宿主进程；其余命令要么连运行中的宿主（经 [`../client`](../client/README.md)），
要么在宿主未运行时离线执行（经 [`../host`](../host/README.md) 的离线命令 / 插件管理）。
随框架包发布为 `bin/chrono.mjs`（编译入口 `dist/packages/boot/main.js`），`boot` 为同指向别名。

## 用法

```
chrono <命令> [--root <路径>] [参数]
# 源码直跑（开发）：
node packages/boot/main.ts <命令> [--root <路径>] [参数]
```

`--root` 给宿主根目录（缺省 `CHRONO_ROOT`，再缺省当前工作目录）；`--root` 可出现在任意位置。已知 flag 均支持
`--flag=value` 形态（首个 `=` 切分；`=` 形态下值可含 `--` 开头的字符，不被当下一枚 flag）。（待确认）
`start` 另收 `--call-timeout-ms <ms>`：效果调用超时（优先级 **CLI > `CHRONO_CALL_TIMEOUT_MS` > 30s 常量**），
生效值随 `{ok, root, pid, call_timeout_ms}` 一并打印；非法值退出码 1（`bad_call_timeout`）。
`start` 还收 `--start-wrapper <cmd>`：把插件 `start` 包住的包装器命令（宿主侧最小沙箱形态，
优先级 **CLI > `CHRONO_START_WRAPPER` > 无**），生效值随 `start_wrapper` 打印；非法值退出码 1（`bad_start_wrapper`）。
`start` 还收 `--watch`：打开源码 watcher（`hot=auto` 的插件跟随改动）。

## 命令

| 分类     | 命令                                                               | 说明                                                                                                                                     |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主     | `start [--call-timeout-ms <ms>] [--start-wrapper <cmd>] [--watch]` | 起宿主（世界单写者，后台守护），就绪后打印 `{ok, root, pid, call_timeout_ms, start_wrapper, watch}`                                      |
| 宿主     | `stop`                                                             | 令宿主按启动序逆序摘除服务并并发 drain 后停机                                                                                            |
| 宿主     | `status`                                                           | 链头与已装载身份清单                                                                                                                     |
| 插件管理 | `add <来源> [--name <n>] [--ref <r>]`                              | 取包（本地路径 / npm 包名 / git 仓库）→ 暂存 `plugins/<name>` → 登记 → 入世；宿主在跑时走 `plugin.ingest`                                |
| 插件管理 | `upgrade <name>`                                                   | 对已暂存插件触发新代码世代（宿主在跑时走 `plugin.ingest`；否则离线 `seed`）                                                              |
| 插件管理 | `remove <name>`                                                    | 退役：撤下暂存 + 撤销登记 + 世界 `retire`（宿主在跑时走 `plugin.remove`）                                                                |
| 插件管理 | `list`                                                             | 列出已登记插件（名字 / 身份 / hot）                                                                                                      |
| 构建     | `term build <目录>`                                                | 用内置 toolchain 编译 `terms.src/*.json` → `terms/*.json`                                                                                |
| 客户端   | `run <directives-json\|@文件>`                                     | 提交 directives 跑一轮，打印 `{run, status, observations}`                                                                               |
| 客户端   | `commands`                                                         | 列出插件声明的命令                                                                                                                       |
| 客户端   | `audit [filter-json\|@文件]`                                       | 只读审计面（`run` / `emitter` / `outcome` / `limit`）                                                                                    |
| 客户端   | `<命令名> [args-json]`                                             | 按声明调用插件命令（`args` 也可用 `@文件`）                                                                                              |
| 离线     | `seed [包路径...]`                                                 | 入世；缺省读 `state/plugins.json`（批量）                                                                                                |
| 离线     | `pack <目录> --identity <id>`                                      | 入世单个插件目录（手动 / 程序化；与 `seed` 共用打包规则；`--identity` 必须与包内 `plugin.json.identity` 一致，否则 `identity_mismatch`） |
| 离线     | `verify`                                                           | 全量校验 journal                                                                                                                         |
| 离线     | `unseeded`                                                         | 列出尚无数据世代的身份（不持锁，只读）                                                                                                   |
| 离线     | `replay`                                                           | 全量重放并给出内容摘要                                                                                                                   |
| 离线     | `compact [--strict]`                                               | 压缩：追加快照 + 冷段归档 + 写基础世界                                                                                                   |
| 离线     | `assets gc` / `blobs gc` / `materialized gc`                       | 回收资产区 / 源码 CAS / 物化目录里世界无引用的字节                                                                                       |
| —        | `help`（或缺省）                                                   | 打印说明                                                                                                                                 |

- `run` 的 `directives` 是内核形态的数组，例：
  `run '[{"kind":"write","request":{"id":"w1","op":"put","target":{"expect_pos":null},"args":{"body":["c",1]},"by":"cli"}}]'`。
- 宿主保留字（插件命令不得占用，入世即拒）：`start` / `stop` / `run` / `status` / `add` / `upgrade` / `remove` /
  `list` / `term` / `seed` / `pack` / `verify` / `replay` / `unseeded` / `compact` / `commands` / `audit` /
  `assets` / `blobs` / `materialized` / `help`（与宿主侧同一份清单，见 `docs/host.md`）。
- 参数含 `@` 前缀时从文件读 JSON（相对当前工作目录）。
- 输出：结果 JSON 走 stdout；错误消息走 stderr，退出码 1。
- **退出码**：用法错误与异常 → 1；`seed` / `pack` / `add` 有任一条目 `failed`、或 `verify` 报告 `ok:false` → 也**非 0**。

## 边界

- 不 import `host` 内部实现——只用 [`host/index.ts`](../host/index.ts) 公共面；`start` 另起进程跑编译后的
  `dist/packages/host/main.js`（源码直跑时为 `packages/host/main.ts`），不经 `startHost`。
- 不 import `toolchain`：`term build` 另起子进程跑编译后的 `dist/toolchain/build.js`。
- 不实现协议、不实现判定；连宿主的一切都在 `packages/client`，离线命令与插件管理是 `packages/host` 的出口。

## 本地检查

```
cd packages/boot
npm ci
npm run typecheck
npm run format:check
npm test             # test/main.test.ts：seed / pack / verify / replay / start 包装器冒烟
```
