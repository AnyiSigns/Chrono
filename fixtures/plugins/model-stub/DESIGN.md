# `model-stub`（测试夹具，非交付）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | —（夹具，不占编号）/ `model-stub` |
| 位置 | `fixtures/plugins/model-stub/`（夹具统一放 `fixtures/plugins/<name>/`） |
| 职责 | 确定性 `model` 实现，供离线验收与 CI |
| 依赖 | pins 无；`<-` 测试 |
| 成员 | execute |
| 能力类·方法 | `implements: ["model"]`，`methods: {model:["chat"]}` |
| 命令 | 无 |
| 机制 | 实现能力类 `model`·`chat`，确定性回包；用于离线验收「换实现不改调用方」与 CI。**与 #12 `model-protocol` 同声明 `model` 能力类——互斥装载**（测试世界用本夹具替换 #12，非共存；2026-09-20 双侧登记，对侧见 `plugins/model-protocol/DESIGN.md` 跨插件登记） |
| 边界 | 不交付；不参与 seed 生产装配 |
| 验收 | 1) 替换真 `model-protocol` 后 15 零改动；2) 回包逐字节可复现 |
| 状态 | 已定（当前**仅本 DESIGN.md，包骨架随 #12 波次补齐**——2026-09-20 修订） |
