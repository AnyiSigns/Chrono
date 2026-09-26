// 插件服务 SDK 公开面：服务协议壳（帧编解码 / 帧循环 / manifest 派生 / 调用派发 / 反向调用通道）。
// 插件侧库，零内核零宿主依赖；插件经 `import ... from 'plugin-sdk'` 使用。

export { canonicalJson, MAX_JSON_DEPTH } from './canonical.ts'
export { asString, isRecord } from './json.ts'
export type { Json, Rec } from './json.ts'
export {
  createFrameDecoder,
  encodeFrame,
  writeFrame,
  MAX_FRAME_BYTES,
  SERVICE_INBOUND_KINDS,
  SERVICE_OUTBOUND_KINDS,
  SERVICE_PROTOCOL_VERSION,
} from './wire.ts'
export type { ServiceInboundKind, ServiceOutboundKind } from './wire.ts'
export { parseCallEnv, nowOf } from './env.ts'
export { deriveManifest, declaredMethods, readPluginJson } from './manifest.ts'
export type { ServiceManifest } from './manifest.ts'
export {
  directivesOf,
  errorValue,
  externDirective,
  externOnly,
  hasDirectives,
  isErrorValue,
  mergeDirectives,
} from './plan.ts'
export { PORT_CALL_TIMEOUT_MS, PortLink } from './port-link.ts'
export type { PortLinkOptions } from './port-link.ts'
export {
  createService,
  isDirectRun,
  loaderEnvFromProcess,
  makeLogger,
  packageRootOf,
  runStdio,
} from './service.ts'
export type { ServiceConfig, ServiceFactoryContext, ServiceInstance } from './service.ts'
export { BadArgsError, ServiceError } from './types.ts'
export type {
  CallEnv,
  Handler,
  HandlerResult,
  PortCaller,
  PortOutcome,
  ServiceEvent,
} from './types.ts'
export { startService } from './driver.ts'
export type { PortBridgeResponse, ServiceDriver, ServiceDriverOptions } from './driver.ts'
