// 同名 toy 服务：`ui-slot` / `ui-nav` 提供方。
// `ui-slot.list` 返回一条状态栏槽声明；`ui-nav.list` 返回一条页面导航记录。
// 消费方（壳）不感知本插件身份；加减本插件只改世界成员表，不改壳 / 侧栏代码。

import { readFileSync } from 'node:fs'
import { navRecordsValue, slotDeclsValue } from '../decls.mjs'

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

function slotDecls() {
  return slotDeclsValue()
}

function navRecords() {
  return navRecordsValue()
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
      if (method !== 'list') {
        writeFrame({ v: PLUGIN.protocol, id, kind: 'error', ok: false, code: 'unresolved_cap' })
        return
      }
      if (port === 'ui-slot') {
        writeFrame({ v: PLUGIN.protocol, id, kind: 'result', ok: true, value: slotDecls() })
        return
      }
      if (port === 'ui-nav') {
        writeFrame({ v: PLUGIN.protocol, id, kind: 'result', ok: true, value: navRecords() })
        return
      }
      writeFrame({ v: PLUGIN.protocol, id, kind: 'error', ok: false, code: 'unresolved_cap' })
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
      process.stderr.write(`[uislot-fixture] handle error: ${err.message}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
