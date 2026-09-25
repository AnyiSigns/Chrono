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

## 依赖方向（写死）

```
boot ──→ client ──→ kernel
  └────→ host ────→ kernel
```

- `host` 只通过 `host/index.ts` 对外；`host` 内部 `assembly` **只读世界**——不 import `effect` / `ledger` 的写口
  （「不认识插件种类」是 import 图上的事实，不是形容词）。
- `boot` 对内核只有类型引用；`client` 运行时另用内核的 `canonicalJson` 做规范序列化（两侧帧格式独立实现）。
- `kernel` 不被任何插件 import；插件不 import 内核、不 import 其他插件包，插件间只走 `pins`（见
  [`docs/plugins.md`](../docs/plugins.md)）。
- 加插件**不改** `packages/` 任何文件：插件包住 `plugins/<name>/` 或 `node_modules/`，由 `state/plugins.json` 列出。
- `toolchain/` 是作者侧**构建期**工具：`packages/` 任何包**不得依赖**它；插件仅不入世的构建 / 开发脚本可 import 其编译器；它至多依赖内核（仅测试器入口），不进运行路径。

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
├── docs/             设计文档（kernel.md 唯一权威）+ plans/（计划，不参与设计口径）
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

| 文档                                      | 内容                                                |
| ----------------------------------------- | --------------------------------------------------- |
| [`docs/kernel.md`](../docs/kernel.md)     | 内核设计（唯一权威）：世界 / 日志 / 写口 / 归约机   |
| [`docs/host.md`](../docs/host.md)         | 载体设计：宿主四个包、边界、硬口径                  |
| [`docs/plugins.md`](../docs/plugins.md)   | 插件规范：`plugin.json`、红线、生命周期、换代       |
| [`docs/protocol.md`](../docs/protocol.md) | 服务协议（宿主 ↔ 插件）与入站协议（发起者 ↔ 宿主）  |
| [`docs/coding.md`](../docs/coding.md)     | 通用编码规范（命名 / 格式 / 结构 / 评审）           |
| `docs/plans/`                             | 实施计划（不含设计口径；`host-plan.md` 是载体计划） |

`docs/chrono-*` 是另一族（独立实验设计），与本实现不接、不参与载体口径。
