# toy-channel

三形态共用入口的 toy 服务夹具：`execute/main.mjs` 既在 stdio 下自行起帧循环，也导出
`createService` 供 inproc / worker 由宿主直调。用于验证同一插件在三种 `transport` 下行为一致。
