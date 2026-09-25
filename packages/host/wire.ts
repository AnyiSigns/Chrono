// 入站协议与服务协议共用的线格式：4 字节大端长度 + 规范序列化的 UTF-8 JSON。
// 入站服务端与客户端各自持有本文件的等价实现（两侧边界独立，不跨包共享）。

import { canonicalJson } from '../kernel/index.ts'
import type { Directive, Json } from '../kernel/index.ts'

/** 入站协议版本；与 `plugin.json.protocol` 是两回事（后者属服务协议）。 */
export const PROTOCOL_VERSION = '1'

export interface Limits {
  gas: number
  depth: number
}

/**
 * 服务调用帧的 `env`（宿主填写，机械）：本回合 run id / 发起者提交信封的 `thread`
 * （原样回带、不校验；detached / 周期 run 恒 `null`）/ 宿主固定时钟 / 发出者身份。
 * 只填帧，不改 `args` 语义；服务发事件载荷、判 TTL 一律用它，不得自取时间。
 * `emitter` 由宿主解析填写、调用方无从伪造：正向调用 = 发出者身份（与审计 `emitter` 同源），
 * 反向 `port.call` 转发 = 发起该反向调用的服务身份，宿主自身发起的调用记 `host`。
 */
export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
  emitter: string | null
}

/** 发起者 → 宿主。 */
export type InboundMessage =
  | {
      v: string
      id: string
      kind: 'submit'
      directives: Directive[]
      caps?: Record<string, boolean>
      limits?: Limits
      /** 可选线程标记：仅随宿主 run 生命周期事件原样回带，宿主不解释。 */
      thread?: string
    }
  | {
      v: string
      id: string
      kind: 'command'
      name: string
      args?: Json
      caps?: Record<string, boolean>
      limits?: Limits
      /** 可选线程标记：仅随宿主 run 生命周期事件原样回带，宿主不解释。 */
      thread?: string
    }
  | {
      v: string
      id: string
      kind: 'forward'
      /** 目标插件身份：宿主只把帧转发给该身份自己的声明入口（插件入站转发）。 */
      identity: string
      /** 目标身份声明的命令名（入口 term 由此解析）。 */
      command: string
      args?: Json
      caps?: Record<string, boolean>
      limits?: Limits
      thread?: string
    }
  | { v: string; id: string; kind: 'cancel'; run: string }
  | { v: string; id: string; kind: 'audit'; filter?: Json }
  | { v: string; id: string; kind: 'asset.put'; mime: string; bytes: string }
  | { v: string; id: string; kind: 'asset.get'; sha256: string }
  | { v: string; id: string; kind: 'secrets.put'; name: string; value: string }
  | { v: string; id: string; kind: 'secrets.delete'; name: string }
  | { v: string; id: string; kind: 'commands' }
  | { v: string; id: string; kind: 'status' }
  | { v: string; id: string; kind: 'stop' }

/** 宿主 → 发起者。 */
export type OutboundMessage =
  | { v: string; id: string; kind: 'accepted'; run?: string }
  | { v: string; kind: 'result'; run: string; status: string; observations: Json[] }
  | { v: string; id: string; kind: 'result'; status: string; observations: Json[] }
  | { v: string; id: string; kind: 'list'; commands: Json[] }
  | { v: string; id: string; kind: 'audits'; records: Json[]; truncated: boolean }
  | { v: string; id: string; kind: 'asset.ref'; ref: Json }
  | { v: string; id: string; kind: 'asset.bytes'; sha256: string; size: number; bytes: string }
  | { v: string; id: string; kind: 'secrets.ok'; name: string }
  | { v: string; id: string; kind: 'state'; world_head: Json; world_rev: Json; loaded: Json[] }
  | { v: string; id: string; kind: 'error'; code: string; message: string }
  | { v: string; impl: string; kind: 'event'; topic: string; payload: Json }

/** 把一条消息编码为一帧（长度前缀 + 规范 JSON 字节）。 */
export function encodeFrame(msg: Json): Uint8Array {
  const body = Buffer.from(canonicalJson(msg), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** 单帧上限：防无界缓冲（本地客户端 / 服务也不许用超大长度前缀压内存）。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 增量解码器：喂入任意分片的字节，产出已完整到达的消息；超限或坏 JSON 抛错。 */
export function createFrameDecoder(): { push: (chunk: Buffer) => Json[] } {
  let buffered: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): Json[] {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages: Json[] = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (length > MAX_FRAME_BYTES) throw new Error('frame_too_large')
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body) as Json)
      }
      return messages
    },
  }
}
