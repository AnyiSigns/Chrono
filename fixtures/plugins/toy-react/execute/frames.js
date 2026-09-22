// 服务协议帧编解码与 stdio 出口（docs/protocol.md §一）：4 字节大端长度 + UTF-8 JSON。
// stdout 只许协议帧；日志一律走 stderr，否则会污染宿主解码器。

/** 单帧上限：与宿主 / 客户端解码器一致（16 MiB）。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 把一条消息编码为一帧（长度前缀 + JSON 字节）。 */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** 写一帧到 stdout（唯一协议出口）。 */
export function writeFrame(message) {
  process.stdout.write(encodeFrame(message))
}

/** 增量解码器：喂入任意分片的字节，产出已完整到达的消息；超限或坏 JSON 抛错。 */
export function createFrameDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (length > MAX_FRAME_BYTES) throw new Error('frame_too_large')
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

/** 日志只走 stderr，绝不污染 stdout 的协议帧。 */
export function log(line) {
  process.stderr.write(`[toy-react] ${line}\n`)
}
