# toy-alpha

toy 独立插件（fixture，仅测试 / 开发用；seed 进临时世界，不进正式世界）。

- 身份：`toy-alpha`
- 能力类：`toy.alpha`，方法：`echo`
- 依赖 pins：无（独立）
- 启动：`node execute/main.js`（stdio 服务；stdout 只发协议帧，日志走 stderr）
- 状态档：`recomputable`（③ 可重算）
- `.worldignore`：声明 `test/`，验证入世排除机制
