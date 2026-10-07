// UI 插件的服务半边共用骨架：宿主根 / 入站 socket 推导、入站客户端、入站桥。
// 供 `plugin-sdk/web` 子路径导入；只依赖 plugin-sdk 内部与 Node 内置模块，零宿主零内核依赖。

export { inboundSocketPath, rootFromPluginState } from './root.ts'
export { InboundClient } from './inbound.ts'
export type { InboundClientOptions } from './inbound.ts'
export {
  Bridge,
  PROTOCOL_VERSION,
  assetGetFrame,
  assetPutFrame,
  cancelFrame,
  commandFrame,
  extractValue,
  forwardFrame,
  interpretResponse,
  newRequestId,
  secretsDeleteFrame,
  secretsPutFrame,
  submitFrame,
  unwrapPlan,
} from './bridge.ts'
export type { InboundResult, RequestOptions, Transport } from './bridge.ts'
