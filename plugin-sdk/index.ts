// 插件服务 SDK 公开面：服务协议壳（帧编解码 / 帧循环 / manifest 派生 / 调用派发 / 反向调用通道）。
// 插件侧库，零内核零宿主依赖；插件经 `import ... from 'plugin-sdk'` 使用。

export { H, canonicalJson, MAX_JSON_DEPTH } from './canonical.ts'
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
export { parseCallEnv } from './env.ts'
export { deriveManifest, declaredMethods, readPluginJson } from './manifest.ts'
export type { ServiceManifest } from './manifest.ts'
export {
  HASH_RE,
  asArray,
  asCount,
  asStringArray,
  defHashOf,
  directivesOf,
  errorValue,
  externDirective,
  externOnly,
  hasDirectives,
  isErrorValue,
  isoAt,
  mergeDirectives,
  nowOf,
  numberField,
  positiveInt,
  summaryOf,
} from './plan.ts'
export { checkToolCalls } from './tool-calls.ts'
export type { ToolCallsCheck } from './tool-calls.ts'
export {
  MAX_CHAIN,
  attributionOf,
  chainEntries,
  contractCost,
  contractEffects,
  contractId,
  contractIndex,
  contractInputs,
  contractOutputs,
  contractPost,
  contractPre,
  contractPublishes,
  contractReads,
  edgePorts,
  edgeWhen,
  effectsCaps,
  effectsMethods,
  effectsPorts,
  graphDerivedFrom,
  graphEdges,
  graphEntrySupply,
  graphLoop,
  graphNodes,
  graphSink,
  isLlmContract,
  nodeAutonomy,
  nodeBindings,
  nodeContractId,
  nodeEntry,
  nodeId,
  nodeImpl,
  nodeLinks,
  nodeScope,
  nodeSubgraph,
  numericThreshold,
  readEntries,
  readGraphModel,
  readPrompts,
  readThresholds,
  retriableOf,
  touchesEffects,
} from './graph-model.ts'
export type { GraphModel } from './graph-model.ts'
export { cacheTokens, normalizeUsage, reasoningBlock } from './model-output.ts'
export type { ReasoningBlock, ReasoningForm } from './model-output.ts'
export {
  DIALECTS,
  buildModelParams,
  formatDialectParts,
  partSupported,
  resolveDialectFormat,
} from './dialect-format.ts'
export type {
  Dialect,
  DialectFormat,
  NeutralAssetRef,
  NeutralPart,
  PartFallback,
} from './dialect-format.ts'
export { PORT_CALL_TIMEOUT_MS, PortLink, settlePortLinks } from './port-link.ts'
export type { PortCallOptions, PortLinkOptions } from './port-link.ts'
export {
  createService,
  defineService,
  isDirectRun,
  loaderEnvFromProcess,
  makeLogger,
  manyNeedsFromProcess,
  packageRootOf,
  pinsFromProcess,
  runStdio,
} from './service.ts'
export type {
  RunStdioOptions,
  ServiceConfig,
  ServiceDefinition,
  ServiceFactoryContext,
  ServiceInstance,
  ServiceLog,
  ServiceSetup,
} from './service.ts'
export { launchNative } from './launch.ts'
export type { NativeLaunchOptions } from './launch.ts'
export {
  BUILTIN_TIER_NET,
  declaredNetOf,
  netRank,
  netScope,
  parseScope,
  tierNetOf,
} from './net-policy.ts'
export type { NetScope } from './net-policy.ts'
export { indexToolDirectory } from './directory.ts'
export type { Directory, Rejection, ToolEntry } from './directory.ts'
export { BadArgsError, ServiceError } from './types.ts'
export type {
  CallContext,
  CallEnv,
  Handler,
  HandlerResult,
  PortCaller,
  PortOutcome,
  ServiceEvent,
} from './types.ts'
export { startService } from './driver.ts'
export type { PortBridgeResponse, ServiceDriver, ServiceDriverOptions } from './driver.ts'
