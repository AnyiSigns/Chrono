// 服务协议级测试（node --test）：spawn `node execute/main.ts`，注入假引擎模块并桥接反向 port.call。
// 覆盖握手 / 控制 / 未知方法 / 反向调用应答 / 会话行为 / 截图资产 / browser_unsupported / net_denied / EOF 自退出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FAKE_ENGINE = join(HERE, 'fake-engine.mjs')

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

function startService(envOverrides = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONO_BROWSER_ENGINE_MODULE: FAKE_ENGINE, ...envOverrides },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const portCalls = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'port.call') {
        portCalls.push(message)
        if (message.port === 'sandbox' && message.method === 'capabilities') {
          child.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'port.result',
              ok: true,
              value: { platform: 'test', implementations: [], default_impl: 'native', enforcement: { net: 'declaration' } },
            }),
          )
        } else if (message.port === 'host' && message.method === 'asset.put') {
          const bytes = Buffer.from(message.args.bytes, 'base64')
          child.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'port.result',
              ok: true,
              value: { kind: 'asset', sha256: createHash('sha256').update(bytes).digest('hex'), mime: message.args.mime, size: bytes.length },
            }),
          )
        } else {
          child.stdin.write(
            encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'unresolved_cap', message: 'no bridge' }),
          )
        }
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
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    exit,
    portCalls,
    request,
    hello: () => request('hello', { impl: 'tool-browser', gen: 'gen-1' }, 'manifest'),
    call: (method, args, env = { run: 'test-run', thread: null, now: 0 }) =>
      request('call', { port: 'tool-browser', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

const bag = (args, extra = {}) => ({ tool: 'webbrowser', args, tier: 'auto', caps: { net: 'all' }, ...extra })

test('hello 回 manifest（与 plugin.json 一致）；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'tool-browser')
    assert.deepEqual(manifest.implements, ['tool-browser'])
    assert.deepEqual(manifest.methods['tool-browser'], ['describe', 'invoke'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('describe 回 webbrowser 契约；未知方法 / 能力类结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const described = await drv.call('describe', {})
    assert.equal(described.kind, 'result')
    const tool = described.value.tools[0]
    assert.equal(tool.name, 'webbrowser')
    assert.equal(tool.caps.net, 'all')
    assert.equal(tool.caps.fs.read, 'none')
    assert.equal(tool.idempotent, false)
    assert.deepEqual(tool.render.detail, { kind: 'json' })
    const unknownMethod = await drv.request('call', { port: 'tool-browser', method: 'nope', args: {} }, 'error')
    assert.equal(unknownMethod.code, 'unknown_method')
    const unknownCap = await drv.request('call', { port: 'other', method: 'describe', args: {} }, 'error')
    assert.equal(unknownCap.code, 'unresolved_cap')
  } finally {
    drv.close()
  }
})

test('会话行为：open → navigate → click → extract → screenshot → close；close 后 session_not_found', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const opened = await drv.call('invoke', bag({ action: 'open' }))
    assert.equal(opened.kind, 'result')
    const session = opened.value.result.session
    assert.equal(session, 'test-run~1')

    const navigated = await drv.call('invoke', bag({ action: 'navigate', session, url: 'https://example.com' }))
    assert.deepEqual(navigated.value.result, { status: 200, url: 'https://example.com', title: 'title:https://example.com' })
    assert.deepEqual((await drv.call('invoke', bag({ action: 'click', session, selector: '#a' }))).value.result, { ok: true })
    assert.deepEqual((await drv.call('invoke', bag({ action: 'extract', session }))).value.result, { text: 'hello body' })

    const shot = await drv.call('invoke', bag({ action: 'screenshot', session }))
    assert.equal(shot.value.result.asset.kind, 'asset')
    assert.match(shot.value.result.asset.sha256, /^[0-9a-f]{64}$/)
    assert.ok(drv.portCalls.some((call) => call.port === 'host' && call.method === 'asset.put'))

    assert.deepEqual((await drv.call('invoke', bag({ action: 'close', session }))).value.result, { closed: true })
    const after = await drv.call('invoke', bag({ action: 'navigate', session, url: 'https://x.test' }))
    assert.equal(after.value.error.code, 'session_not_found')
  } finally {
    drv.close()
  }
})

test('引擎不可用 → browser_unsupported（明确失败，不静默降级）', async () => {
  const drv = startService({ CHRONO_BROWSER_ENGINE_MODULE: join(HERE, 'does-not-exist.mjs') })
  try {
    await drv.hello()
    const opened = await drv.call('invoke', bag({ action: 'open' }))
    assert.equal(opened.value.ok, false)
    assert.equal(opened.value.error.code, 'browser_unsupported')
  } finally {
    drv.close()
  }
})

test('caps.net 越档 → net_denied', async () => {
  const drv = startService()
  try {
    await drv.hello()
    for (const tier of ['severe', 'review']) {
      const opened = await drv.call('invoke', bag({ action: 'open' }, { tier }))
      assert.equal(opened.value.ok, false, `tier=${tier}`)
      assert.equal(opened.value.error.code, 'net_denied', `tier=${tier}`)
    }
  } finally {
    drv.close()
  }
})

test('会话空闲超 TTL 自动回收', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const opened = await drv.call('invoke', bag({ action: 'open' }), { run: 'ttl-run', thread: null, now: 0 })
    const session = opened.value.result.session
    const after = await drv.call('invoke', bag({ action: 'extract', session }), { run: 'ttl-run', thread: null, now: 999999 })
    assert.equal(after.value.error.code, 'session_not_found')
  } finally {
    drv.close()
  }
})
