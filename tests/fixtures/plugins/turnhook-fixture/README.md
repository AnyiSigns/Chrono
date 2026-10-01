# turnhook-fixture

端到端测试夹具：`turn-hook` 扩展类提供方。在 `before-assemble` 固定点返回一条中立 `nudge` 增量
（含 `needle-hook`），由 graph-run 合并进回合状态并经上下文组装可见。加入世界即被 graph-run 按
`many` 成员表逐固定点调用，`session` / `graph-run` 源码零改动。

其余固定点（`after-step` / `before-settle` / `after-settle`）返回空增量。
