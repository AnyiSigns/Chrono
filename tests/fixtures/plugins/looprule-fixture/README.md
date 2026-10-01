# looprule-fixture

端到端测试夹具：`loop-rule` 判据类提供方，判定由 term 承载（`terms/when.json`）。
它只认领一个命名规则 `fixture_loop_never`，对其回 `value:false`；其它名字回 `known:false`，
交回其它成员（默认提供方 loop-policy）。加入世界即被 graph-run 按 `many` 成员表按名求值，
`graph-run/execute/rules.ts` 源码零改动。
