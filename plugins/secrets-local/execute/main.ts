// `secrets-local` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不缓存落盘；本地密钥文件路径归宿主权威，本服务不声明、不创建、不写。
// 本插件是能力类 `secrets-backend` 的提供方，经 `kinds` 自述支持 auth_ref.kind = local。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { secretsFileFromEnv } from './secrets-file.ts'

/** 构造服务实例：本地密钥文件路径由宿主注入的 ③ 目录上溯解析。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'secrets-backend',
  logPrefix: 'secrets-local',
  setup: (ctx) => ({
    handlers: createHandlers({ file: secretsFileFromEnv(ctx.env) }),
  }),
})
