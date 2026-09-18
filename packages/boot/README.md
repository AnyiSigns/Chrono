# boot：CLI 薄壳（genesis 常量）

唯一入口的薄壳：**只做参数解析与转发**，不认识任何业务语义，不做判定、不碰世界。
`start` 拉起宿主进程；其余命令要么连运行中的宿主（经 [`../client`](../client/README.md)），
要么在宿主未运行时离线执行（经 [`../host`](../host/README.md) 的离线命令）。

第一个 `boot` 二进制是 genesis 常量；自改的安全来自「正在运行的旧实例监管下一代实例」（见
[`docs/host.md`](../../docs/host.md) §一）。

## 用法

```
node packages/boot/main.ts <命令> [--root <路径>] [参数]
```

`--root` 给宿主根目录（缺省 `CHRONO_ROOT`，再缺省当前工作目录）；`--root` 可出现在任意位置。
`start` 另收 `--call-timeout-ms <ms>`：效果调用超时（优先级 **CLI > `CHRONO_CALL_TIMEOUT_MS` > 30s 常量**），
生效值随 `{ok, root, pid, call_timeout_ms}` 一并打印；非法值退出码 1（`bad_call_timeout`）。

## 命令

| 分类   | 命令                             | 说明                                                                        |
| ------ | -------------------------------- | --------------------------------------------------------------------------- |
| 宿主   | `start [--call-timeout-ms <ms>]` | 起宿主（唯一写者，后台进程），就绪后打印 `{ok, root, pid, call_timeout_ms}` |
| 客户端 | `stop`                           | 令宿主按反拓扑序 drain 后停机                                               |
| 客户端 | `status`                         | 链头与已装载身份清单                                                        |
| 客户端 | `run <directives-json\|@文件>`   | 提交 directives 跑一轮，打印 `{run, status, observations}`                  |
| 客户端 | `commands`                       | 列出插件声明的命令                                                          |
| 客户端 | `audit [filter-json\|@文件]`     | 只读审计面（`run` / `emitter` / `outcome` / `limit`）                       |
| 客户端 | `<命令名> [args-json]`           | 按声明调用插件命令（`args` 也可用 `@文件`）                                 |
| 离线   | `seed [包路径...]`               | 入世；缺省读 `state/plugins.json`                                           |
| 离线   | `verify`                         | 全量校验 journal                                                            |
| 离线   | `replay`                         | 全量重放并给出内容摘要                                                      |
| 离线   | `compact`                        | 压缩：追加快照 + 冷段归档 + 写基础世界                                      |
| 离线   | `assets gc`                      | 回收资产区里世界无引用的字节                                                |
| —      | `help`（或缺省）                 | 打印说明                                                                    |

- `run` 的 `directives` 是内核形态的数组，例：
  `run '[{"kind":"write","request":{"id":"w1","op":"put","target":{"expect_pos":null},"args":{"body":["c",1]},"by":"cli"}}]'`。
- 宿主保留字（插件命令不得占用，入世即拒）：`start` / `stop` / `run` / `status` / `seed` / `verify` / `replay` / `compact`；
  `commands` / `audit` / `help` 是 CLI 自己的命令，不转发给宿主。
- 参数含 `@` 前缀时从文件读 JSON（相对当前工作目录）。
- 输出：结果 JSON 走 stdout；错误消息走 stderr，退出码 1。

## 边界

- 不 import `host` 内部实现——只用 [`host/index.ts`](../host/index.ts) 公共面；`start` 另起进程跑 `host/main.ts`，不经 `startHost`。
- 不实现协议、不实现判定；连宿主的一切都在 `packages/client`，离线命令是 `packages/host` 的出口。
- 不管理插件清单：`state/plugins.json` 是宿主侧配置，由运维写（见 [`docs/host.md`](../../docs/host.md) §三）。

## 本地检查

```
cd packages/boot
npm ci
npm run typecheck
npm run format:check
npm test             # test/main.test.ts：seed / verify / replay 冒烟
```
