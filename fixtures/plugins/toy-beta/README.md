# toy-beta

toy 插件（fixture，仅测试 / 开发用；seed 进临时世界，不进正式世界）。

- 身份：`toy-beta`
- 能力类：`toy.beta`，方法：`echo`
- 依赖 pins：`toy.alpha` → `toy-alpha`（跨插件依赖）
- 启动：`node execute/main.js`（stdio 服务；stdout 只发协议帧，日志走 stderr）
- 状态档：`recomputable`（③ 可重算）
- `.worldignore`：声明 `test/`，验证入世排除机制
