// 服务协议与 HTTP 面测试（node --test）：路由判定、帧构造 / 解释、端口与静态白名单、
// 以假 Transport 驱动的 HTTP 处理器（command / submit / cancel / asset / state / 静态）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  Bridge,
  assetGetFrame,
  cancelFrame,
  commandFrame,
  extractValue,
  interpretResponse,
  submitFrame,
} from '../execute/bridge.ts'
import { DEFAULT_COMPOSER_PORT, parsePort, resolvePort } from '../execute/port.ts'
import { routeOf } from '../execute/routes.ts'
import { readWebFile, WEB_FILE_RE, webDirOf } from '../execute/static.ts'
import { composerStateRecord, encodeSseRecord, SseHub } from '../execute/events.ts'
import { startUiServer } from '../execute/http-server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(resolve(HERE, '..'), 'execute', 'web')

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function httpCall(port, method, path, body) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers =
      payload === null
        ? {}
        : { 'content-type': 'application/json', 'content-length': payload.length }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolveCall({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

test('路由判定：静态模块 / events / api 动词门禁', () => {
  assert.deepEqual(routeOf('GET', '/entry.js'), { kind: 'entry' })
  assert.deepEqual(routeOf('GET', '/model.js'), { kind: 'web', name: 'model.js' })
  assert.equal(routeOf('POST', '/entry.js').kind, 'not-found')
  assert.equal(routeOf('GET', '/events').kind, 'events')
  assert.equal(routeOf('GET', '/api/state').kind, 'api-state')
  assert.deepEqual(routeOf('GET', '/api/asset'), {
    kind: 'api-asset-get',
    sha256: null,
    mime: null,
  })
  assert.deepEqual(routeOf('GET', `/api/asset/${'a'.repeat(64)}`), {
    kind: 'api-asset-get',
    sha256: 'a'.repeat(64),
    mime: null,
  })
  assert.deepEqual(routeOf('GET', `/api/asset/${'a'.repeat(64)}/image%2Fpng`), {
    kind: 'api-asset-get',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
  })
  assert.equal(routeOf('POST', `/api/asset/${'a'.repeat(64)}`).kind, 'not-found')
  assert.equal(routeOf('GET', '/api/asset/a/b/c').kind, 'not-found')
  assert.equal(routeOf('POST', '/api/command').kind, 'api-command')
  assert.equal(routeOf('POST', '/api/submit').kind, 'api-submit')
  assert.equal(routeOf('POST', '/api/cancel').kind, 'api-cancel')
  assert.equal(routeOf('GET', '/api/command').kind, 'not-found')
  assert.equal(routeOf('POST', '/api/asset').kind, 'not-found')
  assert.equal(routeOf('GET', '/../secret.js').kind, 'not-found')
  assert.equal(routeOf('GET', '/lib/x.js').kind, 'not-found')
})

test('入站桥帧构造与值提取', () => {
  assert.deepEqual(commandFrame('i', 'input.read', { thread: 't1' }, { thread: 't1' }), {
    v: '1',
    id: 'i',
    kind: 'command',
    name: 'input.read',
    args: { thread: 't1' },
    thread: 't1',
  })
  assert.deepEqual(submitFrame('i', [{ kind: 'write' }]), {
    v: '1',
    id: 'i',
    kind: 'submit',
    directives: [{ kind: 'write' }],
  })
  assert.deepEqual(cancelFrame('i', 'r1'), { v: '1', id: 'i', kind: 'cancel', run: 'r1' })
  assert.deepEqual(assetGetFrame('i', 'a'.repeat(64)), {
    v: '1',
    id: 'i',
    kind: 'asset.get',
    sha256: 'a'.repeat(64),
  })
  assert.equal(extractValue({ observations: [{ kind: 'eval', value: { ok: true } }] }).ok, true)
  assert.equal(extractValue({ observations: [{ kind: 'extern', payload: 7 }] }), 7)
  assert.equal(extractValue(null), null)
})

test('回帧解释：通道失败 / error 帧 / 正常回帧三态', () => {
  assert.equal(
    interpretResponse({ ok: false, frame: null, code: 'ui_unreachable', message: 'x' }).ok,
    false,
  )
  const errored = interpretResponse({
    ok: true,
    frame: { kind: 'error', code: 'unknown_command' },
    code: '',
    message: '',
  })
  assert.equal(errored.ok, false)
  assert.equal(errored.code, 'unknown_command')
  const ok = interpretResponse({
    ok: true,
    frame: { kind: 'result', id: 'i' },
    code: '',
    message: '',
  })
  assert.equal(ok.ok, true)
})

test('端口推导与静态文件白名单', () => {
  assert.equal(DEFAULT_COMPOSER_PORT, 8790)
  assert.equal(resolvePort({}), 8790)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_COMPOSER: '9001' }), 9001)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_COMPOSER: '0' }), 8790)
  assert.equal(parsePort('70000'), null)
  assert.equal(WEB_FILE_RE.test('entry.js'), true)
  assert.equal(WEB_FILE_RE.test('../x.js'), false)
  assert.equal(readWebFile(WEB, 'entry.js').includes('export async function mount'), true)
  assert.equal(readWebFile(WEB, 'nope.js'), null)
  assert.equal(readWebFile(WEB, '../plugin.json'), null)
  assert.equal(webDirOf().endsWith('web\\') || webDirOf().endsWith('web/'), true)
})

test('SSE 记录编码与本插件连接态', () => {
  assert.equal(
    encodeSseRecord({ impl: 'host', topic: 'run.started', payload: { run: 'r', thread: 't' } }),
    'data: {"impl":"host","topic":"run.started","payload":{"run":"r","thread":"t"}}\n\n',
  )
  assert.deepEqual(composerStateRecord(true), {
    impl: 'ui-composer',
    topic: 'composer.state',
    payload: { connected: true },
  })
  const hub = new SseHub()
  const chunks = []
  hub.add({ write: (chunk) => chunks.push(chunk) })
  hub.hostEvent('host', 'run.finished', { run: 'r' })
  assert.equal(chunks.length, 1)
  assert.equal(hub.count(), 1)
})

test('HTTP 处理器（假 Transport）：command / submit / cancel / asset / state / 静态', async () => {
  const frames = []
  const transport = {
    isConnected: () => true,
    request: async (frame) => {
      frames.push(frame)
      if (frame.kind === 'command') {
        return {
          ok: true,
          frame: {
            kind: 'result',
            id: frame.id,
            observations: [{ kind: 'eval', value: { ok: true, name: frame.name } }],
          },
          code: '',
          message: '',
        }
      }
      if (frame.kind === 'submit') {
        return {
          ok: true,
          frame: { kind: 'accepted', id: frame.id, run: 'run-1' },
          code: '',
          message: '',
        }
      }
      if (frame.kind === 'cancel') {
        return { ok: true, frame: { kind: 'accepted', id: frame.id }, code: '', message: '' }
      }
      if (frame.kind === 'asset.get') {
        return {
          ok: true,
          frame: {
            kind: 'asset.bytes',
            id: frame.id,
            sha256: frame.sha256,
            size: 3,
            bytes: Buffer.from('abc').toString('base64'),
          },
          code: '',
          message: '',
        }
      }
      return { ok: true, frame: { kind: 'result', id: frame.id }, code: '', message: '' }
    },
  }
  const bridge = new Bridge(transport)
  const port = await freePort()
  const server = await startUiServer(
    { bridge, sse: new SseHub(), connected: () => true, log: () => {} },
    port,
  )
  try {
    const command = await httpCall(port, 'POST', '/api/command', {
      name: 'config.read',
      args: null,
    })
    assert.equal(command.status, 200)
    assert.deepEqual(JSON.parse(command.body).value, { ok: true, name: 'config.read' })

    const submit = await httpCall(port, 'POST', '/api/submit', {
      directives: [{ kind: 'write' }],
      thread: 't1',
    })
    assert.equal(submit.status, 202)
    assert.equal(JSON.parse(submit.body).run, 'run-1')

    const cancel = await httpCall(port, 'POST', '/api/cancel', { run: 'run-1' })
    assert.equal(cancel.status, 200)
    assert.equal(JSON.parse(cancel.body).ok, true)

    const asset = await httpCall(
      port,
      'GET',
      `/api/asset?sha256=${'a'.repeat(64)}&mime=image%2Fpng`,
    )
    assert.equal(asset.status, 200)
    assert.equal(asset.body, 'abc')
    assert.match(String(asset.headers['content-type']), /image\/png/)

    const assetPath = await httpCall(port, 'GET', `/api/asset/${'b'.repeat(64)}/image%2Fpng`)
    assert.equal(assetPath.status, 200)
    assert.equal(assetPath.body, 'abc')
    assert.match(String(assetPath.headers['content-type']), /image\/png/)

    const state = await httpCall(port, 'GET', '/api/state')
    assert.deepEqual(JSON.parse(state.body), { ok: true, connected: true, impl: 'ui-composer' })

    const entry = await httpCall(port, 'GET', '/entry.js')
    assert.equal(entry.status, 200)
    assert.match(entry.body, /export async function mount/)

    const missing = await httpCall(port, 'POST', '/api/command', { args: null })
    assert.equal(missing.status, 400)
    const traversal = await httpCall(port, 'GET', '/../plugin.json')
    assert.equal(traversal.status, 404)

    assert.ok(frames.some((frame) => frame.kind === 'command' && frame.name === 'config.read'))
    assert.ok(frames.some((frame) => frame.kind === 'submit' && frame.thread === 't1'))
    assert.ok(frames.some((frame) => frame.kind === 'cancel' && frame.run === 'run-1'))
    assert.ok(frames.some((frame) => frame.kind === 'asset.get'))
  } finally {
    await server.close()
  }
})

test('命令不可用：error 回帧 → HTTP 502 结构化错误（不崩）', async () => {
  const transport = {
    isConnected: () => true,
    request: async (frame) => ({
      ok: true,
      frame: { kind: 'error', id: frame.id, code: 'unknown_command', message: 'no input.read' },
      code: '',
      message: '',
    }),
  }
  const bridge = new Bridge(transport)
  const port = await freePort()
  const server = await startUiServer(
    { bridge, sse: new SseHub(), connected: () => false, log: () => {} },
    port,
  )
  try {
    const response = await httpCall(port, 'POST', '/api/command', {
      name: 'input.read',
      args: { thread: '_main' },
    })
    assert.equal(response.status, 502)
    assert.equal(JSON.parse(response.body).code, 'unknown_command')
  } finally {
    await server.close()
  }
})
