// 同名 toy 服务：宿主服务协议帧循环（docs/protocol.md §二）。
// 身份 / 能力 / 方法自读同包 plugin.json；行为按身份分派，不读投影、不写世界、不取时间随机。
// stdout 只发协议帧，日志走 stderr；stdin EOF / close / error 即自退出。

import { readFileSync } from 'node:fs'

const PLUGIN = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function writeFrame(message) {
  process.stdout.write(encodeFrame(message))
}

function handle(message) {
  if (!isRecord(message)) return
  switch (message.kind) {
    case 'hello':
      writeFrame({
        v: PLUGIN.protocol,
        id: message.id,
        kind: 'manifest',
        identity: PLUGIN.identity,
        implements: PLUGIN.implements,
        methods: PLUGIN.methods,
        protocol: PLUGIN.protocol,
        state: PLUGIN.state,
      })
      return
    case 'probe':
      writeFrame({ v: PLUGIN.protocol, id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      writeFrame({ v: PLUGIN.protocol, id: message.id, kind: 'ack' })
      return
    case 'drain':
      writeFrame({ v: PLUGIN.protocol, id: message.id, kind: 'bye' })
      return
    case 'call': {
      const id = typeof message.id === 'string' ? message.id : ''
      const port = typeof message.port === 'string' ? message.port : ''
      const method = typeof message.method === 'string' ? message.method : ''
      if (!PLUGIN.implements.includes(port)) {
        writeFrame({ v: PLUGIN.protocol, id, kind: 'error', ok: false, code: 'unresolved_cap' })
        return
      }
      // 返回值带自身身份：多提供方时用它断言元素表与身份一一对应。
      writeFrame({
        v: PLUGIN.protocol,
        id,
        kind: 'result',
        ok: true,
        value: {
          from: PLUGIN.identity,
          port,
          method,
          args: message.args === undefined ? null : message.args,
        },
      })
      return
    }
    default:
      return
  }
}

let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0)
    if (buffered.length < 4 + length) break
    const body = buffered.subarray(4, 4 + length).toString('utf8')
    buffered = buffered.subarray(4 + length)
    try {
      handle(JSON.parse(body))
    } catch (err) {
      process.stderr.write(`[capslot-many-a] handle error: ${err.message}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
