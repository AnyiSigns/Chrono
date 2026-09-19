# host：载体宿主

Chrono 的载体：**一个进程、四个包**（装配 / 效果 / 账本 / 投影）。宿主是唯一常驻进程与**唯一写者**——
抢锁、重放世界、按声明装载插件服务、串行处理入站提交、效果必审计、`done` 才落账。
载体设计见 [`docs/host.md`](../../docs/host.md)；内核口径见 [`docs/kernel.md`](../../docs/kernel.md)（唯一权威）。

两条边界写死：

- `assembly` **只读世界**——不写链、不改 `active`、不执行效果、不认识插件种类（不 import `effect` / `ledger` 写口）。
- 插件**不 import 内核**：键 / 哈希 / 校验 / 写链全在宿主；插件只提交内容与效果请求。

## 四个子包

| 子包          | 职责                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `assembly/`   | 装配：声明解析、`pins` 闭包与拓扑、源码入世 / 物化、起停服务、握手、端点表、世代跟随                  |
| `effect/`     | 效果：A1 路由、连接与调用、通用 run loop、`EffectAudit`、唯一写口、`results` 回灌与续跑、A10 轮间驱动 |
| `ledger/`     | 账本：journal 文件读写、全量 `verify` / `replay`、单写者锁                                            |
| `projection/` | 投影：`base_only` 只读视图，作为 `directive` 的 `ctx` 交给 term                                       |

`assembly/` 文件：

| 文件                  | 职责                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `decl.ts`             | 从世界读 `plugin.json`、解析包内成员路径、列 / 解析命令           |
| `closure.ts`          | 沿 `pins` 只读遍历 → SCC + 逆拓扑启动序 + 坏分支隔离事件          |
| `source.ts`           | 插件包源码树 → `defs`（文件 → blob、目录 → tree）+ `.worldignore` |
| `ingest.ts`           | 入世计划：源码树 → 一条原子 `batch` 的 ops（含 term `$ref` 替换） |
| `materialize.ts`      | 物化：世界 `commit` → 源码树 → 工作副本（③，与入世互逆）          |
| `term-refs.ts`        | term 源里 `{"$ref":"terms/foo.json"}` 的机械替换                  |
| `args-schema.ts`      | 命令 `argsSchema` 方言：入世元校验 + 命令入口机械校验             |
| `service-launcher.ts` | 起一个服务：物化 → spawn（stdio）→ hello / manifest → 组装运行态  |
| `runtime.ts`          | 装配运行时：启动序、健康探针、重启、换代跟随（A6）、停机          |
| `generation.ts`       | 换代判据：按 `members` 跨代比对路径 + 内容 → 数据 / 代码          |
| `supervision.ts`      | 监督工具：重启 / 健康策略解析、退避、进程树终止、失败分类         |
| `index.ts`            | 子包出口                                                          |

`effect/` 文件：`route.ts`（A1 路由：发出者 `pins` → def → 属主 → active → 端点表）、
`execute.ts`（效果执行 + 审计直写）、`run-loop.ts`（单轮跑到 done / refused / idle + 续跑）、
`rounds.ts`（A10：done 落账 → plan 通道 → 分相 → 下一轮；`ctx` 投影注入）。

根文件：`host.ts`（抢锁 → 重放 → 装配 → 开 socket → 串行处理）、`main.ts`（进程入口）、`index.ts`（公共面，只此一面）、
`offline.ts`（`seed` / `pack` / `verify` / `replay`）、`paths.ts`（落盘路径单点）、`service-link.ts`（服务协议宿主侧）、
`lifecycle.ts`（运维日志）、`wire.ts`（线格式）、`endpoint-table.ts`（`impl+gen+cap+method` → 物理端点）。

## 运行流程

```
startHost
  ① 抢单写者锁（state/runtime 锁文件）
  ② 全量重放 journal → 世界 + 链头
  ③ 装配：pins 闭包 → 逆拓扑序 → 逐个物化 / spawn / 握手 → 端点表；坏分支只隔离
  ④ 开入站 socket，写类提交（submit / 命令）FIFO 串行；status 等只读即时应答
  ⑤ 每轮 done 落账（业务 journal）→ A6 换代跟随 → 下一轮
stop
  等在途提交 → 断开客户端 → 反拓扑序逐个 drain 服务 → fsync → 释放锁 → 退出（不写链、不改 active）
```

- 一拍效果：`run` 挂起 → A1 路由 → 服务 `call` → `EffectAudit` **先落** → `results` 回灌 → 同 `run_id` / `now` / `directives` 续跑；
  **只有 `done` 才落业务账**（`ref` 指向审计）。
- 换代跟随：宿主自身 `active` 换代才动作——数据热生效（`reload` / `ack`，进程不动）、代码起新服务 + 旧服务 `drain`；
  依赖换代只由路由重解析，依赖 `retire` / `set_active(null)` 则运行期 fail-closed 隔离（`dep.retired`）。
- `run` 内 `set_active` 只在下一轮 / 下一 run 生效；`refused` / `waiting` 的 `pos` 一律作废。

## 运维日志

宿主独有取证：`state/lifecycle.log`（JSONL，逐行原子追加 + fsync），**不进世界、不进链、不参与重放**。

| `kind`      | `event`                                       | 触发                      |
| ----------- | --------------------------------------------- | ------------------------- |
| `host`      | `start` / `stop` / `start_failed`             | 宿主自起停 / 启动选项非法 |
| `dep`       | `cycle` / `stale` / `drift` / `retired`       | 装配解析 / 依赖退役       |
| `handshake` | `failed` / `extra_dropped`                    | 握手校验                  |
| `service`   | `start_failed` / `exit` / `restart_exhausted` | 起服务 / 进程             |

## 落盘布局

```
<root>/state/
├── world/          journal.jsonl + 基础世界 —— 真源（备份它 = 备份世界）
├── runtime/        物化工作副本 / 锁 —— ③ 可重算（删了重建）
├── plugins.json    插件包清单 [{name, path?}] —— 宿主侧配置，运维写，不进世界
├── sock/           入站面 socket —— 平台相关、不可重放
└── lifecycle.log   运维日志
```

根目录缺省当前工作目录，可用 `--root` 或 `CHRONO_ROOT` 覆盖（`paths.ts` 单点解析）。物理端点 / pid **永不进世界**。

## 用法

```ts
import { startHost } from './index.ts'

const host = await startHost({ root }) // 也可注入更短 callTimeoutMs / startWrapper（测试）
// … 客户端连 host.socket 提交 …
await host.stop()
```

`startHost` 可配 `startWrapper`（宿主侧服务启动包装器）：只把插件 `start` 包住，不参与声明解析、
不改 `plugin.json` 契约、不引入特权插件；缺省无（零行为变化）。

CLI 走 [`../boot`](../boot/README.md)：

```
node packages/boot/main.ts seed fixtures/plugins/toy-alpha
node packages/boot/main.ts pack fixtures/plugins/toy-alpha --identity toy-alpha
node packages/boot/main.ts start [--start-wrapper <cmd>]
node packages/boot/main.ts status
node packages/boot/main.ts stop
```

离线 `seed` 按 `state/plugins.json` 批量入世；`pack` 单目录手动 / 程序化入世——两者**共用同一套打包规则**，
同一目录同一身份产出相同的源码 tree / commit 哈希（新身份 `add_identity` + `add_gen`，已存在身份只 `add_gen`）。

错误码（`writer_busy` / `unresolved_cap` / `not_loaded` / `stale` / `bad_args` / `transport_failed` / …）见
[`docs/protocol.md`](../../docs/protocol.md) §四。

## 测试

```
cd packages/host
npm ci
npm run typecheck
npm run format:check
npm test
```

| 测试位置                                                                                      | 覆盖                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `test/host-integration.test.ts`                                                               | 入站面：seed → start → status.loaded、停机、event 广播、listen 失败收口      |
| `test/host-effect.test.ts`                                                                    | 效果：审计先落、回灌续跑、refused、并发提交串行化                            |
| `test/host-generation.test.ts`                                                                | 世代跟随：`add_gen` / `set_active` / `retire`、依赖漂移与退役、双写者        |
| `test/host-projection.test.ts`、`test/host-python.test.ts`                                    | 投影只读、跨语言（Python）服务                                               |
| `test/offline-pack.test.ts`、`test/host-start-wrapper.test.ts`                                | `pack` 入世（新 / 已存在身份、坏包整批拒、与 `seed` 同哈希）/ 服务启动包装器 |
| `test/host.test.ts`、`test/offline.test.ts`、`test/service-link.test.ts`、`test/wire.test.ts` | 单轮基础 / 离线命令 / 服务协议 / 线格式                                      |
| `assembly/test/`、`effect/test/`、`ledger/test/`、`projection/test/`                          | 各子包单元与行为不变量                                                       |

## 不做什么

不做原地热补丁、不做多写者、不做多链合并、不做调度、不定义审批语义、不做插件资源隔离、
不做 event 背压 / 订阅过滤（完整清单见 [`docs/host.md`](../../docs/host.md) §七）。
