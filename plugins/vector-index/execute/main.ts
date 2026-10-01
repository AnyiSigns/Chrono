// `vector-index` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 索引本体落本身份 ③（`CHRONO_PLUGIN_STATE/index.bin`）；记录随 args 传入，无反向调用、无写通道。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { resolveStateDir } from './vector-index.ts'

/** 构造服务实例：③ 目录取自宿主注入 env，缺省只驻内存。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'vector-index',
  logPrefix: 'vector-index',
  setup: (ctx) => ({
    handlers: createHandlers(resolveStateDir(ctx.env)),
  }),
})
