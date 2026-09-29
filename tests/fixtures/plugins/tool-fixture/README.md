# tool-fixture

最小工具提供方夹具：`implements: ["tool-provider"]`，只回一个合法工具声明（`fixture.echo`）。

用于证明「扩展点零改动加减提供方」：新增 / 删除一个 `tool-provider` 提供方后，`tool-registry` /
`tool-dispatch` / `tools` 链路代码与声明都不改，目录随宿主注入的世界成员表自动增减。

自实现最小服务协议帧循环，不依赖 `plugin-sdk`、无第三方依赖，便于测试直接 spawn。
