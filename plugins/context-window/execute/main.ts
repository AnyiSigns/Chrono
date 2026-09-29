// `context-window` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 计数 / 预算经反向 `port.call`（`token-estimate` / `budget`），应答帧即时结算（不排队）。
// 启动即加载 policy；失败 ⇒ 在 hello 前退出非 0（宿主隔离）。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import { handleBuild, assertBag } from './methods.ts'
import { loadPolicy } from './policy.ts'
import { createBackends } from './port-link.ts'
import type { Policy } from './types.ts'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'

const CAPABILITY = 'context'
const LOG = makeLogger('context-window')

function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'context-window' })
  const backends = createBackends(link)
  let policy: Policy = loadPolicy()
  const handlers: Record<string, Handler> = {
    build: async (args, env) => {
      assertBag(args)
      return handleBuild(args, env, policy, backends)
    },
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
    onReload: () => {
      try {
        policy = loadPolicy()
        LOG('reload policy reloaded')
      } catch (err) {
        LOG(`reload policy failed, keeping current: ${(err as Error).message}`)
      }
    },
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG, onMalformedFrame: 'exit' })
  LOG(`service started (pid ${process.pid})`)
}
