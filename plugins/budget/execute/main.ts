// `budget` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 预算建模 / 每模型系数 / EWMA 校准全住本提供方；校准状态落 CHRONO_PLUGIN_STATE/calibration.json。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'budget',
  logPrefix: 'budget',
  setup: () => ({ handlers: createHandlers() }),
})
