# ctxsource-fixture

端到端测试夹具：`context-source` 扩展类提供方，`collect` 返回一条稳定记录（`fixture-memory`，
`stability:'stable'`）与一条动态记录（`fixture-retrieval`，`stability:'dynamic'`）。
加入世界即被 `graph-run` 在 `context.assemble` 前置经 `many` 成员表反向拉取，装配器与消费方零改动。
