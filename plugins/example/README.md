# example（示例插件）

本目录只是**形状示例**，用于对照 `docs/plugins.md` §二，**不是**真实能力插件。

```
plugins/example/
├── package.json     npm 信封（宿主不解释）
├── plugin.json     插件契约（12 字段；宿主解释）
├── README.md       本文件（人读自述）
├── execute/        执行件源码（0..n）——自带服务进程
├── terms/         term def（0..n）——判定 / 评分 / 门禁
├── test/          该插件的所有测试
├── .worldignore      该插件需要排除入世的目录/文件
└── schema/         声明 schema（0..n）
```

- 入世后才生效：`boot seed` 把本目录 → `blob` / `tree` / `commit` defs。
- 加插件**只加** `plugins/<name>/`，**不改** `packages/` 下任何文件。
- 字段清单见 `docs/plugins.md` §二；做法红线见 §三；协议见 `docs/protocol.md` §二。
- `plugin.json` 的子字段 schema 在 S2 冻结前只作示例，以届时 `schema/` 为准。
