// `token-estimate` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// 启动即加载原生 tokenizer：失败 ⇒ 在 hello 前退出非 0（宿主隔离，绝不回落 JS 计数）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。

import {
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { loadTokenizer, nativeLoadedFrom, tokenizerVersion } from './native.ts'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'token-estimate'
const LOG = makeLogger('token-estimate')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  // 原生 tokenizer：唯一计数实现，加载失败即服务启动失败（在 hello 前抛出）。
  loadTokenizer()
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers(),
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG, onMalformedFrame: 'exit' })
  LOG(
    `service started (pid ${process.pid}); tokenizer=${tokenizerVersion()} from ${nativeLoadedFrom() ?? '?'}`,
  )
}
