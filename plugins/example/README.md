# example（形状模板插件）

> **定位（2026-09-20 修订）**：本目录只是**目录形状 / `plugin.json` 12 字段模板**，用于对照 `docs/plugins.md` §二，**不是**真实能力插件，也**不是参考实现**。
> **参考实现**是 `fixtures/plugins/toy-alpha`（含完整 stdio 帧协议服务、断连自退出、`.worldignore`、测试与合格 README；另有 `toy-beta` / `toy-python`）——写执行件、协议义务、`.worldignore`、README 自述时以它为准。

```
plugins/example/
├── package.json     npm 信封（宿主不解释）
├── plugin.json     插件契约（12 字段；宿主解释）
├── README.md       本文件（人读自述）
├── execute/        执行件源码（0..n）——自带服务进程（本目录为空占位）
├── terms/         term def（0..n）——判定 / 评分 / 门禁
├── test/          该插件的所有测试（不随源码入世界：须在 .worldignore 声明）
├── .worldignore      入世排除表（本文件声明了 test/）
└── schema/         声明 schema（0..n）
```

## 这是什么

形状模板：演示一个插件包必须长什么样。`plugin.json` 的 12 字段齐全、形态合法（含 `restart` / `health` 合法枚举）；但 `execute/` 只有占位、`start` 指向的 `execute/main.js` **并不存在**——真实插件必须自带可执行的服务实现（协议帧自实现，见 `docs/protocol.md` §二）。

## 提供哪些能力与命令

无（模板不提供真实能力）。真实插件的义务：

- `stdout` 只许协议帧、日志一律走 `stderr`；
- **断连自退出**（stdin EOF / 管道断开即退出，避免孤儿进程）；
- 测试放 `test/` 并在 `.worldignore` 里声明（宿主只自动排除 `node_modules` / `.git`，**`test/` 不会自动排除**）。

## 怎么起

`plugin.json.start` 是占位值。真实插件按自带实现填写（宿主只跑 `start`、不认识语言；非 TS 插件见 `docs/host.md` §五「非 TS 插件物化」）。

## 状态档

`state: "recomputable"`（③ 可重算；v1 只允许此值）。

## 另注

- 入世后才生效：`boot seed` 把本目录 → `blob` / `tree` / `commit` defs。
- 加插件**只加** `plugins/<name>/`，**不改** `packages/` 下任何文件。
- 字段清单见 `docs/plugins.md` §二；做法红线见 §三；协议见 `docs/protocol.md` §二。
- `plugin.json` 的子字段 schema 在 S2 冻结前只作示例，以届时 `schema/` 为准。
