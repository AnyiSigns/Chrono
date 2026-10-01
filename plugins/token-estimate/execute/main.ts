// `token-estimate` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// 启动即加载原生 tokenizer：失败 ⇒ 在 hello 前退出非 0（宿主隔离，绝不回落 JS 计数）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { loadTokenizer, nativeLoadedFrom, tokenizerVersion } from './native.ts'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'token-estimate',
  logPrefix: 'token-estimate',
  onMalformedFrame: 'exit',
  onStarted: (log) =>
    log(
      `service started (pid ${process.pid}); tokenizer=${tokenizerVersion()} from ${nativeLoadedFrom() ?? '?'}`,
    ),
  setup: () => {
    // 原生 tokenizer：唯一计数实现，加载失败即服务启动失败（在 hello 前抛出）。
    loadTokenizer()
    return { handlers: createHandlers() }
  },
})
