// `context-window` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// 启动即加载原生 tokenizer 与 policy：任一失败 ⇒ 在 hello 前退出非 0（宿主隔离，绝不回落 JS 计数）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。

import { createService as createSdkService, isDirectRun, makeLogger, packageRootOf, runStdio } from 'plugin-sdk'
import { handleBuild, assertBag } from './methods.ts'
import { loadTokenizer, nativeLoadedFrom, tokenizerVersion } from './native.ts'
import { loadPolicy } from './policy.ts'
import type { Policy } from './types.ts'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'context'
const LOG = makeLogger('context-window')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  // 原生 tokenizer：唯一实现，加载失败即服务启动失败（在 hello 前抛出）。
  loadTokenizer()
  let policy: Policy = loadPolicy()
  const handlers: Record<string, Handler> = {
    build: (args, env) => {
      assertBag(args)
      return handleBuild(args, env, policy)
    },
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log: LOG,
    intercept: (message) => {
      if (message['kind'] === 'reload') {
        try {
          policy = loadPolicy()
          LOG('reload policy reloaded')
        } catch (err) {
          LOG(`reload policy failed, keeping current: ${(err as Error).message}`)
        }
      }
      return false
    },
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
  LOG(`service started (pid ${process.pid}); tokenizer=${tokenizerVersion()} from ${nativeLoadedFrom() ?? '?'}`)
}
