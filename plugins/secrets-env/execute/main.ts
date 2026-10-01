// `secrets-env` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道、不缓存落盘；`env` kind 取本服务进程环境，明文只在返回值里。
// 本插件是能力类 `secrets-backend` 的提供方，经 `kinds` 自述支持 auth_ref.kind = env。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/** 构造服务实例：`env` kind 读本服务进程环境。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'secrets-backend',
  logPrefix: 'secrets-env',
  setup: () => ({ handlers: createHandlers({ env: process.env }) }),
})
