# host：载体宿主

Chrono 的载体：**一个进程、四个包**（装配 / 效果 / 账本 / 投影）。宿主是唯一常驻进程与**世界单写者**——
抢锁、重放世界、按声明装载插件服务、串行处理入站提交、效果必审计、`done` 才落账。
载体设计见 [`docs/host.md`](../../docs/host.md)；内核口径见 [`docs/kernel.md`](../../docs/kernel.md)（唯一权威）。

两条边界写死：

- `assembly` **只读世界**——不写链、不改 `active`、不执行效果、不认识插件种类（不 import `effect` / `ledger` 写口）。
- 插件**不 import 内核**：键 / 哈希 / 校验 / 写链全在宿主；插件只提交内容与效果请求。

## 四个子包

| 子包          | 职责                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `assembly/`   | 装配：声明解析、`pins` 闭包与拓扑、源码入世 / 物化、起停服务、握手、端点表、世代跟随                  |
| `effect/`     | 效果：A1 路由、连接与调用、通用 run loop、`EffectAudit`、世界写口、`results` 回灌与续跑、A10 轮间驱动 |
| `ledger/`     | 账本：journal 文件读写、全量 `verify` / `replay`、单写者锁                                            |
| `projection/` | 投影：`base_only` 只读视图，作为 `directive` 的 `ctx` 交给 term                                       |

`assembly/` 文件：

| 文件                  | 职责                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `decl.ts`             | 从世界读 `plugin.json`、解析包内成员路径、列 / 解析命令                                                                                     |
| `closure.ts`          | 沿 `pins` 只读遍历 → SCC + 逆拓扑启动序 + 坏分支隔离事件                                                                                    |
| `source.ts`           | 插件包源码树 → `defs`（文件 → blob、目录 → tree）+ `.worldignore`                                                                           |
| `ingest.ts`           | 入世计划：源码树 → 一条原子 `batch` 的 ops（含 term `$ref` 替换）                                                                           |
| `ecosystem.ts`        | 生态 profile：锁文件名 / 通用排除名 / npm·cargo 环境 / SDK 布局 / 同语言入口扩展名的内建默认，可被 `chrono.config.json` 的 `ecosystem` 覆盖 |
| `materialize.ts`      | 物化：世界 `commit` → 源码树 → 工作副本（③，与入世互逆）                                                                                    |
| `assets-manifest.ts`  | 投递目录大资产直拷：`schema.assets_manifest` → 物化目录（sha256）                                                                           |
| `term-refs.ts`        | term 源里 `{"$ref":"terms/foo.json"}` 的机械替换                                                                                            |
| `args-schema.ts`      | 命令 `argsSchema` 方言：入世元校验 + 命令入口机械校验                                                                                       |
| `eff-decls.ts`        | 入世期 eff 声明校验：term 里的效果头必须落在声明的能力面内                                                                                  |
| `service-launcher.ts` | 起一个服务：物化 → spawn（stdio）→ hello / manifest → 组装运行态                                                                            |
| `service-host.ts`     | 服务进程模型：按 `transport` 选 stdio / inproc / worker 的加载与通信形态                                                                    |
| `deps.ts`             | 依赖恢复与构建：按 `decl.build` 执行、按生态 profile 注入 npm / cargo 缓存                                                                  |
| `sdk-provision.ts`    | SDK 供给：物化树内建 `plugin-sdk` 链接（JS 与 Rust 同规）                                                                                   |
| `runtime.ts`          | 装配运行时：启动序、健康探针、重启、换代跟随（A6）、停机                                                                                    |
| `swap.ts`             | 代码换代的换人序：缺省「先起新 → 切端点 → drain 旧」/ 独占序                                                                                |
| `generation.ts`       | 换代判据：按 `members` 跨代比对路径 + 内容 → 数据 / 代码                                                                                    |
| `capability-index.ts` | 世界级能力索引：能力类 → 提供方 / 拥有方身份集（按身份名字典序）                                                                            |
| `start-layers.ts`     | 装配启动分层：同层并发、层间顺序                                                                                                            |
| `supervision.ts`      | 监督工具：重启 / 健康策略解析、退避、进程树终止、失败分类                                                                                   |
| `index.ts`            | 子包出口                                                                                                                                    |

`effect/` 文件：`route.ts`（A1 路由：发出者 `pins` → def → 属主 → active → 端点表）、
`execute.ts`（效果执行 + 审计草稿，交宿主**旁路侧存**）、`run-loop.ts`（单轮跑到 done / refused / idle + 续跑）、
`rounds.ts`（A10：done 落账 → plan 通道 → 分相 → 下一轮；`ctx` 投影注入）。

根文件：`host.ts`（抢锁 → 重放 → 装配 → 开 socket → 串行处理）、`main.ts`（进程入口）、`index.ts`（公共面，只此一面）、
`offline.ts`（`seed` / `pack` / `verify` / `replay`）、`paths.ts`（落盘路径单点）、`service-link.ts`（服务协议宿主侧）、
`lifecycle.ts`（运维日志）、`wire.ts`（线格式）、`endpoint-table.ts`（`impl+gen+cap+method` → 物理端点）、
`host-capability.ts`（保留能力类 `host` 方法）、`validate-package.ts`（入世校验 dry-run）、
`periodic.ts`（`schema.periodic` 定时触发）、`secrets.ts`（密钥本地存储面）、`assets.ts` / `blobs.ts`（内容寻址字节）、
`writer.ts` / `world-commit.ts`（世界单写者与落账）、`bootstrap.ts` / `composition.ts` / `capability-wiring.ts`（组合根与接线）、
`run-registry.ts`（run 登记与取消）、`plugin-data.ts` / `plugin-state.ts`（④ / ③ 目录注入）、`protected-pins.ts`（受保护 pin 名单）、
`port-audit.ts`（端口审计环形缓冲）、`audit*.ts`（审计侧存 / 分档 / 脱敏 / 回填）、`compact.ts`（账本压缩）、`options.ts`（启动选项与策略默认）。

`common/` 是宿主内层共享机制（不 import `effect` / `ledger` 写口）：`op-names.ts` 内核 op 名镜像、
`json` / `jsonl` / `cas` / `paths-safe` / `gc-dirs` / `fs-atomic` / `call-timeout` / `min-heap` 等。`common/platform/`
是**平台适配层**：集中全部 OS 特定原语——地址（`socketAddress`）、进程（`killProcessTree` / `isProcessAlive` /
`detachedProcessGroup`）、文件系统（`symlinkDirOrJunction` / `chmodIfSupported` / `fsyncDir` / `writeFileAtomic`）、
`isWindows` 判定；`process.platform` 分支只住此目录，其余模块一律经它调用。

**生态 profile**（`assembly/ecosystem.ts`）把宿主对「语言 / 工具链」的默认假设集中为**声明式默认**——锁文件名、
通用排除名、npm / cargo 缓存环境变量与目录名、`plugin-sdk` 包布局、同语言入口扩展名；未配置时全部走内建默认、
不产生行为变化，可由仓库根 `chrono.config.json` 的 `ecosystem` 键（或 `CHRONO_ECOSYSTEM` 环境变量，JSON 文本）整体或部分覆盖，
形态非法 fail-closed 拒 `bad_ecosystem`。它只影响入世 / 依赖恢复 / SDK 供给的机械假设，不改变「构建与启动由插件
`decl.build` / `decl.start` 声明」的口径。

结构 op 名单的宿主镜像 `common/op-names.ts` 与内核 `kernel/types.ts` 的 `Op`、`kernel/commit.ts` 的
`VALID_OPS` 三份同源，由仓库级门禁 `tests/static/op-name-parity.test.mjs` 对表；client / host 入站线常量由
`tests/static/host-client-wire-parity.test.mjs` 钉死。发布 `files` 清单覆盖全部根源文件与源码目录，由
`test/package-files.test.ts` 把关。

## 运行流程

```
startHost
  ① 抢单写者锁（state/runtime 锁文件）
  ② 全量重放 journal → 世界 + 链头
  ③ 装配：pins 闭包 → 逆拓扑序 → 逐个物化 / spawn / 握手 → 端点表；坏分支只隔离
  ④ 开入站 socket，写类提交（submit / 命令）FIFO 串行；status 等只读即时应答
  ⑤ 每轮 done 落账（业务 journal）→ A6 换代跟随 → 下一轮
stop
  等在途提交 → 断开客户端 → 启动序逆序摘除服务并**并发** drain（各服务独立有界等待）→ fsync → 释放锁 → 退出（不写链、不改 active）
```

- 一拍效果：`run` 挂起 → A1 路由 → 服务 `call` → `EffectAudit` **先落旁路侧存**（`state/audit/`，不进世界、
  不占 `seq`、业务 write 不落 `ref`）→ `results` 回灌 → 同 `run_id` / `now` / `directives` 续跑；
  **只有 `done` 才落业务账**；审计与回合按 `run` / `emitter` 在侧存关联（权威口径见 [`docs/host.md`](../../docs/host.md)）。
- 换代跟随：宿主自身 `active` 换代才动作——数据热生效（`reload` / `ack`，进程不动）、代码起新服务 + 旧服务 `drain`；
  依赖换代只由路由重解析，依赖 `retire` / `set_active(null)` 则运行期 fail-closed 隔离（`dep.retired`）。
- `run` 内 `set_active` 只在下一轮 / 下一 run 生效；`refused` / `waiting` 的 `pos` 一律作废。
- 停机服务摘除按启动序**逆序**同步完成（从服务表移除、清计时器），但各服务的 `drain` / 终止**并发等待**——单个卡住的服务不拖垮整体停机。**后果**：drain 期间被依赖者可能先退场，依赖者在途调用可得 `not_loaded`；这是**正常停机行为，不是故障**。

## 运维日志

宿主独有取证：`state/lifecycle.log`（JSONL，逐行原子追加，内存缓冲 + 有界延迟批量落盘），**不进世界、不进链、不参与重放**。

| `kind`      | `event`                                                                                                                                                                                                                                                | 触发                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`      | `start` / `stop` / `start_failed`                                                                                                                                                                                                                      | 宿主自起停 / 启动选项非法                                                                                                                                                               |
| `host`      | `watch_*` / `gc_failed` / `plugin_discovery_skipped` / `journal_tail_repaired` / `listen_error` / `persist_fatal_stop` / `run_failed` / `follow_failed` / `protected_pins_unset` / `method_deprecated` / `invalid_frame` / `capability_owner_conflict` | watcher / 启动 GC 失败 / 目录发现跳过 / journal 尾修复 / 监听错误 / 落账致命停机 / run 异常 / 跟随失败 / 受保护 pin 未配置 / 命中保留方法弃用别名 / 畸形帧无法配对 / 能力类多拥有方告警 |
| `dep`       | `cycle` / `stale` / `drift` / `retired` / `periodic_invalid` / `method_timeout_invalid` / `assets_manifest_invalid` / `suspended` / `resumed`                                                                                                          | 装配解析 / 依赖退役 / 周期、方法级超时与资产清单声明非法 / 运行期休眠 · 恢复                                                                                                            |
| `handshake` | `failed` / `extra_dropped`                                                                                                                                                                                                                             | 握手校验                                                                                                                                                                                |
| `service`   | `start_failed` / `exit` / `restart_exhausted`                                                                                                                                                                                                          | 起服务 / 进程                                                                                                                                                                           |

## 落盘布局

```
<root>/state/
├── world/          journal.jsonl + 基础世界 —— 真源（备份它 = 备份世界）
├── runtime/        物化工作副本 / 锁 —— ③ 可重算（删了重建）
├── plugins.json    插件包清单 [{name, path?}] —— 宿主侧配置，运维写，不进世界
├── sock/           入站面 socket —— 平台相关、不可重放
├── audit/          效果审计旁路侧存（audit.jsonl + meta.json）—— 不进世界、不参与重放
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

| 测试位置                                                                                      | 覆盖                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `test/host-integration.test.ts`                                                               | 入站面：seed → start → status.loaded、停机、event 广播、listen 失败收口                  |
| `test/host-effect.test.ts`                                                                    | 效果：审计先落、回灌续跑、refused、并发提交串行化                                        |
| `test/host-generation.test.ts`                                                                | 世代跟随：`add_gen` / `set_active` / `retire`、依赖漂移与退役、双写者                    |
| `test/host-projection.test.ts`、`test/host-python.test.ts`                                    | 投影只读、跨语言（Python）服务                                                           |
| `test/offline-pack.test.ts`、`test/host-start-wrapper.test.ts`                                | `pack` 入世（新 / 已存在身份、坏包整批拒、与 `seed` 同哈希）/ 服务启动包装器             |
| `test/host.test.ts`、`test/offline.test.ts`、`test/service-link.test.ts`、`test/wire.test.ts` | 单轮基础 / 离线命令 / 服务协议 / 线格式                                                  |
| `test/host-capability.test.ts`、`test/host-periodic.test.ts`、`test/host-forward.test.ts`     | 保留能力类 `host`（`source.read` / `asset.*` / `validate_package`）/ 定时触发 / 入站转发 |
| `test/host-env.test.ts`、`assembly/test/assets-manifest.test.ts`                              | 调用帧 `env` 注入（含反向 `port.call`）/ 投递目录大资产直拷                              |
| `assembly/test/`、`effect/test/`、`ledger/test/`、`projection/test/`                          | 各子包单元与行为不变量                                                                   |

## 宿主受信面（v1）

宿主保留能力类 `host`（`host-methods.ts`）与内置**密钥本地存储面**（入站 `secrets.put` / `secrets.delete` +
世界只存引用 `auth_ref = {kind:'local'|'env', name}`）是 **v1 受信面**：无方法级鉴权，过滤责任在调用方，宿主不强制；
密钥本体直写 `state/secrets.local.json`（`0600`），不经 run、不进世界、不进审计、不参与重放。该密钥面是
**可替换候选**——消费端另有 `secrets-local` / `secrets-env` 插件，存储面收敛需另行处理。

## 不做什么

不做原地热补丁、不做多写者、不做多链合并、不做调度、不定义审批语义、不做插件资源隔离、
不做 event 背压 / 订阅过滤（完整清单见 [`docs/host.md`](../../docs/host.md) §七）。
