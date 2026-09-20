# #34 `router`（模型 / 能力选择）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 34 / `router` |
| 职责 | 模型 / 能力选择（**选别名端口名**）；**v1 不实现降级链**（机制骨架保留待 v2） |
| 依赖 | `+` 2（vendor / model / 当前选择由调用方入口 term 读 `ctx.ids.config.body` 后经 `select` args 传入；本插件服务**不读投影**，D8）；`<-` 14 / 33（**新增** pins：`router` → 34） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["router"]`，`methods: {router:["select"]}` |
| 命令 | 无 |
| schema | `schema/router.json`（最小形状 `{ "primary": "model" }`；别名清单形状 v1 不定义、待 v2） |
| 机制 | `select(bag)`：从**调用方入口 term 读投影后经 args 传入**的 vendor / model / 当前选择 + 候选**别名清单** → 返回**选中的别名端口名**（**v1 = no-op：恒返回 `schema.primary`（`model`）**，不接别名分支）；调用方 term 把该返回值作 `eff.port`（`port` 是运行时值）→ 宿主按发出者 `pins` 解析。**主名与每个备选别名各自是独立 pin**；**候选别名清单 ⊆ 调用方 `pins` 的键**（不在 `pins` 里的别名装配期即 `unresolved_cap`）；按 `host.md` §五 路由，**别名必须 ∈ 目标身份声明的能力类**，故每个备选身份需**显式声明自己的别名能力类**（否则同名冲突 / `unresolved_cap`）。降级顺序由 term 判定，宿主不自动重试 |
| 边界 | 不做：调用实现（只选，不调）/ **改调用方的 `model` pin 指向**（`model` 仍 pin 12）/ **重试 / 退避 / 限流 / 流断重连（归 #12 `model-protocol`，v1 已做）** / 落账 / **图拓扑与节点选择（归 33 `loop-policy`）** |
| 验收 | 1) **v1 不接备选**（全仓无第二个 `model` 实现、无身份声明别名能力类）：`select` 恒返回主名 `model`（= `schema.primary`，no-op），机制骨架就位但不验证别名分支（v2 接入）；2) 换 34 实现不改 14 / 33 的 term；3) 选择确定可回放（v1 恒返回主名）；4) **别名验收后置**（v2 有备选实现并显式声明别名能力类时才验：备选未声明别名能力类装配期即 `unresolved_cap`；别名 ∈ 调用方 `pins` 键） |
| 状态 | 本轮修正：**原「#14 / #33 的 pin 由 12 改指 34」口径作废**——`#34` 声明 `router` 而非 `model`，把 `model` pin 改指 34 会 `unresolved_cap`。正确做法：**保留 `model` → 12**，**新增** `router` → 34，并为每个备选实现**新增独立别名 pin**（别名 = 该备选身份声明的能力类）。**2026-09-19 定调**：**v1 不实现降级链**（无备选 model 实现、别名清单形状 v1 不定义），机制骨架保留待 v2；别名验收后置 |
