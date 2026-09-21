// 服务上行事件出口（docs/protocol.md §2.5）：宿主只透传、不落账、不推进。
// model.delta 逐段上行，载荷带 run / thread（自协议帧 env 读取，不自取时间）。

import { log, writeFrame } from './frames.ts'
import type { Json } from './types.ts'

let seq = 0

/** 上行一条 `event` 帧；写失败只记 stderr，不影响调用结果。 */
export function emitEvent(topic: string, payload: Json): void {
  seq += 1
  try {
    writeFrame({ v: '1', id: `model-evt-${seq}`, kind: 'event', topic, payload })
  } catch (err) {
    log(`write event failed: ${(err as Error).message}`)
  }
}
