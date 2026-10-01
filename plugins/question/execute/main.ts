// `question` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写链通道：队列与游标写自有持久存储；
// 作答槽经反向调用 `input.read` / `input.clear` 读写（槽属 `input` 身份）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { QuestionStore } from './store.ts'

/** 构造服务实例：反向调用通道 + 自有存储，均由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'question',
  logPrefix: 'question',
  defaultState: 'durable',
  setup: (ctx) => {
    const link = new PortLink({ write: ctx.emit, idPrefix: 'question' })
    return {
      handlers: createHandlers({ store: QuestionStore.open(ctx.env), input: link }),
      portLinks: [link],
      eventIdPrefix: 'question-evt',
    }
  },
})
