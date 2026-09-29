# embedding-fixture

扩展点 `embedding-provider` 的夹具提供方：声明模型 `x`（8 维），按 `x` 返回确定性向量。

- 身份：`embedding-fixture`
- 能力类 / 方法：`embedding-provider` → `embed` / `describe-models`
- 用途：测试门面 `embedding` 的扩展点选择与路由（选 `x` → 路由到本提供方），以及成员集变化后重注入。

服务自实现最小协议帧循环（不依赖 `plugin-sdk`），便于测试直接 spawn。
