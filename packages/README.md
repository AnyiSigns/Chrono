# Chrono 载体实现（packages）

`packages/` 是 Chrono 的实现面，四个包：内核是纯函数库（无 IO、不装载、不执行效果）；宿主是唯一常驻进程与
世界单写者（内部再分装配 / 效果 / 账本 / 投影四个子包）；CLI 是 genesis 常量薄壳；客户端库是连入站面的唯一入口。
设计与口径以 [`docs/kernel.md`](../docs/kernel.md)（内核）与 [`docs/host.md`](../docs/host.md)（载体）为准；
本目录各包自述见下表。

## 包一览

| 包        | 是什么                                                                           | 入口                            | 自述                                   |
| --------- | -------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| `kernel/` | 内核：值层 / 归约机 / 哈希链日志 / 世界写口；纯函数、无 IO、不装载、不执行效果   | `kernel/index.ts`               | [`kernel/README.md`](kernel/README.md) |
| `host/`   | 载体宿主：装配 / 效果 / 账本 / 投影；一个常驻进程、世界单写者                    | `host/index.ts`、`host/main.ts` | [`host/README.md`](host/README.md)     |
| `client/` | 入站面客户端库：connect / submit / command / commands / status / stop / 收 event | `client/index.ts`               | [`client/README.md`](client/README.md) |
| `boot/`   | CLI 薄壳（genesis 常量）：`start` 起宿主，其余命令连宿主或离线执行               | `boot/main.ts`                  | [`boot/README.md`](boot/README.md)     |

各包自带 `node_modules` 与锁文件，**仓库无根 workspace**；进入包目录各自 `npm ci`。

各包公共面单点在各自 `index.ts`：内核 `kernel/index.ts` 只 re-export（含 term 原语名单 `TERM_TAGS`、两个身份
`entryHash` / `worldRev` 等）；宿主 `host/index.ts` 是唯一公开面。评审只从公共面导入，**加导出 = 改规格**。

## 依赖方向（写死）

```
boot ──→ client ──→ kernel
  └────→ host ────→ kernel
```

- `host` 只通过 `host/index.ts` 对外；`host` 内部 `assembly` **只读世界**——不 import `effect` / `ledger`
  （「不认识插件种类」是 import 图上的事实，不是形容词：`assembly` 触达的宿主顶层模块只有 `blobs` /
  `endpoint-table` / `host-methods` / `lifecycle` / `paths` / `plugin-data` / `protected-pins` /
  `service-link` / `wire`，无一条路径通向两个写口）。判定类常量（如调用超时缺省值与硬上限）住
  `host/common/`，不住被判定方，否则配置层会反向依赖运行层而让这条断言失效。
- `boot` 对内核只有类型引用；`client` 运行时另用内核的 `canonicalJson` 做规范序列化（两侧帧格式独立实现）。
- `kernel` 不被任何插件 import；插件不 import 内核、不 import 其他插件包，插件间只走 `needs`（见
  [`docs/plugins.md`](../docs/plugins.md)）。
- 红线由仓库级静态门禁 `tests/static/plugin-redline.test.mjs` 钉死：插件**运行期源码**（`execute/` / `src/`
  / `terms/` / `test/`）不得 import `packages/*`、不得跨插件直连；仅 `plugins/<插件>/tools/**` 的 dev /
  构建脚本（被各插件 `.worldignore` 排除、宿主不物化不装载）可 import 宿主内部面。
- 加插件**不改** `packages/` 任何文件：插件包住 `plugins/<name>/` 或 `node_modules/`，由 `state/plugins.json` 列出。
- `toolchain/` 是作者侧**构建期**工具：`packages/` 任何包**不得依赖**它；插件仅不入世的构建 / 开发脚本可 import 其编译器；它至多依赖内核（仅测试器入口），不进运行路径。

## 冻结（2026-09-27 生效）

`packages/` 四包已冻结。冻结后只允许两类改动：

1. **算法与细节优化**：同行为前提下的性能、可读性、内部结构调整。
2. **明确缺陷修复**：有复现、有根因、判定为 `packages/` 侧缺陷的修复。

其它一切需求由改插件满足。冻结的目的是让插件层可整体替换——换 agent、全部插件换掉、加入新形态插件——而
`packages/` 不动。故本目录必须保持轻量且薄：它机械执行 `docs/` 定义的契约，不认识任何具体插件，不承载业务语义。

**`host/index.ts` 是宿主的唯一公开面**：加导出 = 改规格，属冻结范围内的规格变更，需与解冻同等对待。

### 冻结后仍需解冻的清单

以下词表是硬封闭的，加成员必须改 `packages/`。不做可扩展注册表（与轻量目标冲突），改为登记在案：扩其中任一项
即为**协议演进**，需一次有记录的解冻，不算违反冻结。

| 词表 | 位置 |
| --- | --- |
| `host.*` 方法集（宿主保留方法，含 `run.spawn` / `run.cancel` 与一个协议版本的弃用别名 `thread.resume` / `thread.terminate`） | `host/host-methods.ts`；路由闸 `host/effect/route.ts`；派发 `host/host-capability.ts`；别名弃用日志 `host/capability-wiring.ts` |
| 服务传输形态 | `host/assembly/decl.ts`（声明校验）、`host/assembly/service-host.ts`（选择）、`host/service-link.ts`、`host/endpoint-table.ts` |
| 入站动词 | `host/wire.ts`、`host/inbound/dispatch.ts`、客户端镜像 `client/index.ts` |
| 服务协议帧 | `host/service-link.ts` |
| `plugin.json` 各枚举 | `host/assembly/decl.ts`（`members.kind` / `transport` / `state`）、`host/assembly/supervision.ts`（`restart` / `backoff`） |
| `plugin.json` 字段 `needs` / `slots` 与 `commit.body.meta.needs` | `host/assembly/decl.ts`、`host/assembly/ingest.ts`、`host/assembly/runtime.ts`（提供方按拥有方契约注册端点） |
| `plugin.json` 字段 `judgments`（由 term 承载的能力方法，宿主命中就地求值、不 spawn 服务）+ 端点形态 `transport='term'` | `host/assembly/decl.ts`、`host/assembly/ingest.ts`、`host/assembly/runtime.ts`（判定方法不登记服务端点）、`host/assembly/supervision.ts`（握手覆盖豁免）、`host/endpoint-table.ts`、`host/effect/route.ts`、`host/effect/judgment.ts`、`host/composition.ts` |
| 路由语义（`resolve` 的 needs 分支 / `resolveSlot` / `many` fan-out / 聚合审计） | `host/effect/route.ts`、`host/effect/run-loop.ts`、`host/effect/execute.ts` |
| `validate_package` 结果形状 | `host/validate-package.ts` |
| 运行期 `pins` 投影 = 该身份代码世代 `commit.body.meta.needs` 的 `one` 绑定（cap → 被依赖身份名） | `host/projection/index.ts`、`docs/host.md` |
| 服务工厂上下文 `pins`（宿主注入有效 pins = `one` 绑定）+ stdio spawn env `CHRONO_PLUGIN_PINS` | `host/assembly/decl.ts`、`host/assembly/service-host.ts`、`host/assembly/service-launcher.ts`、`plugin-sdk/service.ts` |
| 服务工厂上下文新增 `manyNeeds`（宿主注入 `many` 成员表：cap → 身份名，世界索引）+ stdio spawn env `CHRONO_PLUGIN_MANY_NEEDS`；反向 `port.call` 支持「按成员定位的 `many`」（帧带 `provider`，`route.resolve` 校验 `needs.mode=many` 且目标 ∈ 索引） | `host/assembly/capability-index.ts`、`host/assembly/service-host.ts`、`host/assembly/service-launcher.ts`、`host/effect/route.ts`、`plugin-sdk/service.ts`、`plugin-sdk/port-link.ts` |
| `plugin-sdk/rust` 新增 `PortLink::call_with_provider`（反向调用帧带 `provider`，按成员定位 `many`）与 `many_needs_from_env`（解析 `CHRONO_PLUGIN_MANY_NEEDS`，键/成员码元序） | `plugin-sdk/rust/src/port.rs`、`plugin-sdk/rust/src/service.rs`、`plugin-sdk/rust/src/lib.rs` |
| `host.*` 方法集新增休眠 `identities.suspend` / `identities.resume` | `host/host-methods.ts`、`host/host-capability.ts`、`host/capability-wiring.ts`、`host/assembly/runtime.ts` |
| `audit_tier` 首命中改身份名字典序 | `host/audit-tiers.ts` |
| `argsSchema` 方言 | `host/assembly/args-schema.ts` |
| schema 宿主消费键 | `host/periodic.ts`、`method-timeouts.ts`、`audit-tiers.ts`、`audit-redact.ts`、`assembly/assets-manifest.ts` |
| 结构化 op / directive / term 原语 | `kernel/types.ts`（`Op` / `Directive` 等）、`kernel/machine.eval.ts`（term 原语 `TERM_TAGS` 与求值，经 `machine.ts` 转口）；宿主侧镜像 `host/common/op-names.ts`、`host/assembly/eff-decls.ts` |
| `set_active` / `retire` / `fork` 的 `expect_*` 门禁 | 尚不存在（`kernel/journal.apply.ts` 只有 `add_gen` / `graft` 经 `expect_active` 把关）——补它属协议演进 |

term 原语表有防漂移双保险：宿主 `walkEffs` 以内核 `TERM_TAGS` 为权威，遇内核列了而本表无分支的头即拒整包
`bad_term:<head>`，另有遍历 `TERM_TAGS` 的覆盖测试。故加原语而漏改宿主不会静默放行，会当场失败。

结构 op 名单三份真源——`kernel/types.ts` 的 `Op`、`kernel/commit.ts` 的 `VALID_OPS`、`host/common/op-names.ts`
的宿主镜像 `OP_NAMES`——由仓库级门禁 `tests/static/op-name-parity.test.mjs` 逐字对表（含顺序）；client / host
两侧各自实现、不跨包共享的入站线常量（命名管道前缀与根摘要长度、`PROTOCOL_VERSION`、`MAX_FRAME_BYTES`）由
`tests/static/host-client-wire-parity.test.mjs` 钉死。

### 已知不由 packages 承担的责任

- **回合不跨重启续跑**：宿主不持久化 run 游标、不自动重发效果。重启后由插件自行判断未完成的回合并重发。
  `host.run.spawn` 是调用方驱动的**新**分离 run，不是内核 `waiting` 态的续跑。
- **插件独立性无宿主侧强制**：「插件不得互相 import、不得 import 宿主」目前靠约定与各插件自带的
  `test/package.test.mjs`。宿主只强制结构性屏障（term `$ref` 限同包、`eff` 端口须在 `implements` ∪ `needs`、
  运行期路由只认 `meta.needs` 绑定与自身 `implements`），且这些入世门禁不覆盖运行期顶层 `add_gen`。

## 一次调用的数据流

```
CLI / UI / 测试 / 以客户端身份连入的插件
        │  packages/client（本地 socket，不开 TCP）
        ▼
   host 入站面 ── directive / 命令 ──→ 通用 run loop（内核 run）
        │                                   │
        │ 装配 assembly                     │ eff → 路由 → 端点表
        ▼                                   ▼
  服务子进程（stdio） ←── call / result ── 服务协议（host/service-link.ts）
        │
  账本 ledger：state/world/journal.jsonl ← 世界写口（内核 commit）
```

- 插件服务 = 宿主 spawn 的子进程：协议帧走 stdout、日志走 stderr（[`docs/protocol.md`](../docs/protocol.md) §一 / §二）。
- 物理端点（pid / 管道）只住宿主侧 `state/runtime/`，**永不进世界**；`state/world/` 是真源。

## 顶层布局

```
Chrono/
├── docs/             设计文档（`kernel.md` 唯一权威）
├── packages/         本目录：kernel / client / boot / host
├── plugins/          插件包源码位置（一个插件 = 一个 npm 包；位置非分类）
├── toolchain/        第一方作者工具（构建期，非运行时；运行时不得依赖）
├── fixtures/plugins/ toy 插件（仅测试 / 开发；seed 进临时世界，不进正式世界）
├── experiment/       独立实验树（standalone，不接内核）
└── state/            宿主侧落盘（gitignore；永不进世界）
```

## 怎么跑

```
cd packages/host     # kernel / client / boot 同理，各自独立安装
npm ci
npm run typecheck    # tsc --noEmit
npm run format:check # Prettier
npm test             # vitest
```

最小闭环（Node 24 可直接执行 `.ts`，在仓库根运行）：

```
node packages/boot/main.ts seed fixtures/plugins/toy-alpha   # 离线入世（宿主未运行）
node packages/boot/main.ts start                             # 起宿主（世界单写者，后台进程）
node packages/boot/main.ts status                            # 链头 + 已装载身份
node packages/boot/main.ts stop                              # 反拓扑序 drain 后停机
```

## 文档地图

| 文档                                      | 内容                                               |
| ----------------------------------------- | -------------------------------------------------- |
| [`docs/kernel.md`](../docs/kernel.md)     | 内核设计（唯一权威）：世界 / 日志 / 写口 / 归约机  |
| [`docs/host.md`](../docs/host.md)         | 载体设计：宿主四个包、边界、硬口径                 |
| [`docs/plugins.md`](../docs/plugins.md)   | 插件规范：`plugin.json`、红线、生命周期、换代      |
| [`docs/protocol.md`](../docs/protocol.md) | 服务协议（宿主 ↔ 插件）与入站协议（发起者 ↔ 宿主） |
| [`docs/coding.md`](../docs/coding.md)     | 通用编码规范（命名 / 格式 / 结构 / 评审）          |

`docs/chrono-*` 是另一族（独立实验设计），与本实现不接、不参与载体口径。
