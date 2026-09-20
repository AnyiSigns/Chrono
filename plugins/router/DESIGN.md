# #34 `router`（模型 / 能力选择）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 34 / `router` |
| 职责 | 模型 / 能力选择（**选别名端口名**）；调用面为 **#33 服务内降级判定**（`agent.step` 失败 → `port.call router.select` → 按返回端口名 `port.call` 备选）（2026-09-20 修订） |
| 依赖 | pins 无（`select` 纯判定、不调模型、不读投影）；`<-` **33（pins：`router`——#33 装配时声明；`model` pin 与备选别名 pin 亦声明在调用方 #33）**（2026-09-20 修订） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["router"]`，`methods: {router:["select"]}` |
| 命令 | 无 |
| schema | `schema/router.json`（**形状已冻结**（出生即固定，避免日后被迫 fork）：`{"primary":"model", "aliases":[]}`——`primary` 为本插件声明的默认别名端口名（调用方须有同名 pin）；v1 `aliases` 为空数组占位，出现备选实现时写数据世代填入）（2026-09-20 修订） |
| 机制 | **调用方 = #33 服务内降级判定**：`agent.step` 失败（error 值 / 拒绝码）→ #33 `port.call router.select`（args = 候选端口名清单 + 失败码；候选来自 #33 自己的 pins——主名 `model` + 别名 pin 名）→ `select` 返回选中的端口名（只有主名时恒返回主名，机械）→ #33 以该 port 名再 `port.call` 备选实现。**term 无动态端口（eff 的 port 是 AST 字面量），#14 静态管道不接**（降级链只在 #33 图执行内生效）（2026-09-20 修订） |
| 边界 | 不做：调用实现（只选，不调）/ **改调用方的 `model` pin 指向**（`model` 仍 pin 12）/ **重试 / 退避 / 限流 / 流断重连（归 #12 `model-protocol`，v1 已做）** / 落账 / **图拓扑与节点选择（归 33 `loop-policy`）** |
| 验收 | 1) 被 #33 调用：`agent.step` 失败后按 `select` 结果路由到别名实现；无别名候选时 `select` 恒返回主名（机械 no-op）——随 #33 集成验收（W6）；2) 生产 seed 无第二个 `model` 实现（`model-stub` 为测试夹具、互斥装载）；3) 不改任何调用方 `pins` 指向（2026-09-20 修订） |
| 状态 | 本轮修正：**原「#14 / #33 的 pin 由 12 改指 34」口径作废**——`#34` 声明 `router` 而非 `model`，把 `model` pin 改指 34 会 `unresolved_cap`。正确做法：**保留 `model` → 12**，**新增** `router` → 34，并为每个备选实现**新增独立别名 pin**（别名 = 该备选身份声明的能力类）。**2026-09-20 修订（取代 2026-09-19「v1 不实现降级链 / 待 v2」口径）**：调用面改 #33（服务内降级判定，静态管道不接）；**别名清单 schema 形状已冻结**（`{"primary":"model","aliases":[]}`，v1 空数组——无备选实现时 `select` 恒返回主名，机械 no-op）；出现备选实现即填入数据世代生效。 |
