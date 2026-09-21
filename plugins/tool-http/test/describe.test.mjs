// describe 契约测试：四要素 / argsSchema / caps / idempotent / render，含一次协议往返。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describeTools } from '../execute/describe.ts'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

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

function startService() {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
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
    const id = `drv-${seq}`
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => rejectRequest(new Error(`timeout waiting ${kind}`)), 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }
  return { child, request }
}

test('describe 值：两工具四要素齐备、caps 含 fs.read、idempotent 与 render 正确', () => {
  const { tools } = describeTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['websearch', 'webfetch'])
  for (const tool of tools) {
    for (const key of ['intent', 'when_to_use', 'boundaries']) {
      assert.equal(typeof tool[key], 'string')
      assert.ok(tool[key].length > 0, `${tool.name}.${key} 为空`)
    }
    assert.ok(Object.keys(tool.param_semantics).length > 0)
    assert.equal(tool.idempotent, true)
    assert.ok(tool.argsSchema && tool.argsSchema.type === 'object')
    assert.ok(tool.caps.fs && typeof tool.caps.fs.read === 'string')
    assert.equal(tool.caps.fs.write, 'none')
    assert.equal(typeof tool.caps.net, 'string', 'caps.net 必须是字符串 scope，不得用布尔')
    assert.ok(['none', 'limited', 'all', 'unset'].includes(tool.caps.net), `非法 caps.net：${tool.caps.net}`)
    assert.equal(tool.render.form, 'card')
    assert.equal(tool.render.tone, 'ghost')
    assert.equal(tool.render.live, false)
  }
  const websearch = tools[0]
  assert.deepEqual(websearch.argsSchema.required, ['query'])
  assert.deepEqual(websearch.argsSchema.properties.sources.items, { type: 'string' })
  assert.deepEqual(websearch.render.detail, { kind: 'list', fields: ['title', 'url', 'snippet', 'source'] })
  assert.equal(websearch.render.summary, '{query}')
  assert.equal(websearch.caps.net, 'limited')
  const webfetch = tools[1]
  assert.deepEqual(webfetch.argsSchema.required, ['url'])
  assert.deepEqual(webfetch.render.detail, { kind: 'code', lang: 'markdown' })
  assert.equal(webfetch.render.summary, '{url}')
  assert.equal(webfetch.caps.net, 'all')
})

test('协议往返：hello → manifest，describe → 结果，未知方法 → 结构化错误', async () => {
  const { child, request } = startService()
  try {
    const manifest = await request('hello', { impl: 'tool-http', gen: 'test' })
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'tool-http')
    assert.deepEqual(manifest.implements, ['tool-http'])
    assert.deepEqual(manifest.methods, { 'tool-http': ['describe', 'invoke'] })
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')

    const described = await request('call', { port: 'tool-http', method: 'describe', args: {} })
    assert.equal(described.kind, 'result')
    assert.equal(described.value.tools.length, 2)

    const badMethod = await request('call', { port: 'tool-http', method: 'nope', args: {} })
    assert.equal(badMethod.kind, 'error')
    assert.equal(badMethod.code, 'unknown_method')

    const badPort = await request('call', { port: 'nope', method: 'describe', args: {} })
    assert.equal(badPort.code, 'unresolved_cap')
  } finally {
    child.stdin.end()
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
})
