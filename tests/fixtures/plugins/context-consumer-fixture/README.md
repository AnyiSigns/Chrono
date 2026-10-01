# context-consumer-fixture

端到端测试夹具：无服务，仅一个 term 命令 `plug.context-build`——对 `context`（`one`）发正向 `eff build`，
入参即调用方传的 bag。用于断言新增 `context-source` 提供方后上下文生效，而消费方声明零改动。
