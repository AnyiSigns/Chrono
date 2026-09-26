// `tool-browser` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出，
// 并关闭全部浏览器会话（防孤儿进程）。反向调用走 SDK `PortLink`，回带发起 call 帧 id。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Handler, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { loadConfig } from './config.ts'
import { describe } from './describe.ts'
import { createEngine } from './engine/factory.ts'
import { invoke } from './invoke.ts'
import { installShutdownHandlers } from './lifecycle.ts'
import { log } from './log.ts'
import { SessionManager } from './sessions.ts'

const CAPABILITY = 'tool-browser'
const CONFIG = loadConfig()

/** 构造服务实例：会话管理 + 反向调用通道归本插件，帧循环由 SDK 驱动。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'tool-browser' })
  const sessions = new SessionManager(createEngine, CONFIG, CONFIG.sessionIdleMs)
  let exiting = false

  /** 停机：关闭全部浏览器会话（不泄漏进程）。 */
  function shutdown(): Promise<void> {
    if (exiting) return Promise.resolve()
    exiting = true
    return sessions.closeAll().then(
      () => undefined,
      () => undefined,
    )
  }

  // 信号 / 退出兜底：SIGTERM / SIGINT 走优雅停机，`exit` 同步硬杀残留浏览器子进程。
  installShutdownHandlers(process, {
    shutdown: () => {
      void shutdown()
    },
    killAllSync: () => sessions.killAllSync(),
  })

  const handlers: Record<string, Handler> = {
    describe: () => ({ value: describe(), events: [] }),
    invoke: async (args, env, call) => ({
      value: await invoke(args, { sessions, link }, env, call.callId),
      events: [],
    }),
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers,
    emit: ctx.emit,
    log,
    portLinks: [link],
    onDrain: () => shutdown(),
    onClose: () => {
      void shutdown()
    },
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log })
}
