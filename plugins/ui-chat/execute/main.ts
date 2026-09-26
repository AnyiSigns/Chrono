// `ui-chat` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 浏览器侧经壳总线直接按名调用宿主命令，本服务只负责健康占位（`ui-chat.ping`）与客户端半边只读交付。

import { fileURLToPath } from 'node:url'

import {
  BadArgsError,
  createService as createSdkService,
  isDirectRun,
  isRecord,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { Json, ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { isSafeClientPath, readClientFile } from './client-read.ts'

const CAPABILITY = 'ui-chat'
const LOG = makeLogger('ui-chat')

/** 客户端半边源码目录：`execute/web/`（`path` 相对此目录解析）。 */
const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))

/** 只读交付客户端半边产物：参数 `{path}`，只接受包内相对 `.js` 路径。 */
function handleClientRead(args: Json): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const path = args['path']
  if (!isSafeClientPath(path)) throw new BadArgsError('unsafe client path')
  const text = readClientFile(WEB_DIR, path)
  if (text === null) throw new Error('client file not found')
  return { path, text }
}

/** 构造服务实例：健康占位与客户端半边只读交付。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: {
      ping: () => ({ value: { pong: true, identity: CAPABILITY }, events: [] }),
      'client.read': (args) => ({ value: handleClientRead(args), events: [] }),
    },
    emit: ctx.emit,
    log: LOG,
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
