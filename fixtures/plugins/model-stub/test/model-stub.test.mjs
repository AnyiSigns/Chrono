// `model-stub` 夹具测试：协议级驱动，断言握手与确定性回包。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.js')

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

function start() {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})
  let seq = 0
  function request(kind, fields) {
    seq += 1
    const id = `t-${seq}`
    return new Promise((resolveRequest) => {
      pending.set(id, resolveRequest)
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }
  return {
    child,
    events,
    hello: () => request('hello', { impl: 'model-stub', gen: 'g' }),
    chat: (bag) => request('call', { port: 'model', method: 'chat', args: bag, env: { run: 'r', thread: 't', now: 0 } }),
    close: () => child.stdin.end(),
  }
}

test('manifest 与 plugin.json 一致', async () => {
  const drv = start()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'model-stub')
    assert.deepEqual(manifest.implements, ['model'])
    assert.deepEqual(manifest.methods.model, ['chat'])
  } finally {
    drv.close()
  }
})

test('chat 确定性：同输入两次逐字节一致，且上行一条 model.delta', async () => {
  const drv = start()
  try {
    await drv.hello()
    const bag = { config: { model: 'stub' }, messages: [{ role: 'user', content: 'hello' }] }
    const first = await drv.chat(bag)
    const second = await drv.chat(bag)
    assert.equal(first.kind, 'result')
    assert.equal(first.value.ok, true)
    assert.equal(JSON.stringify(first.value), JSON.stringify(second.value))
    assert.equal(drv.events.length, 2)
    assert.equal(drv.events[0].topic, 'model.delta')
    assert.equal(drv.events[0].payload.text, first.value.text)
  } finally {
    drv.close()
  }
})
