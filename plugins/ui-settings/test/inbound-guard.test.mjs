// 入站面收紧测试：Host 白名单 / Origin 校验 / 写方法 JSON 体约束，含真实服务端集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'

import { guardInboundRequest } from '../execute/inbound-guard.ts'
import { startUiServer } from '../execute/http-server.ts'

const PORT = 8799

function fakeReq(method, headers) {
  return { method, headers }
}

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

function rawCall(port, method, path, headers, body) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8')
    const finalHeaders = { ...headers }
    if (payload !== null) finalHeaders['content-length'] = payload.length
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: finalHeaders },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolveCall({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

test('入站校验：Host 只认本进程监听端口的 127.0.0.1 / localhost', () => {
  assert.equal(guardInboundRequest(fakeReq('GET', { host: `127.0.0.1:${PORT}` }), PORT), null)
  assert.equal(guardInboundRequest(fakeReq('GET', { host: `localhost:${PORT}` }), PORT), null)
  const forged = guardInboundRequest(fakeReq('GET', { host: 'evil.example:8799' }), PORT)
  assert.equal(forged.status, 403)
  assert.equal(forged.code, 'forbidden_host')
})

test('入站校验：Origin 有则必须同源', () => {
  const base = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' }
  assert.equal(
    guardInboundRequest(fakeReq('POST', { ...base, origin: `http://127.0.0.1:${PORT}` }), PORT),
    null,
  )
  assert.equal(
    guardInboundRequest(fakeReq('POST', { ...base, origin: `http://localhost:${PORT}` }), PORT),
    null,
  )
  const cross = guardInboundRequest(fakeReq('POST', { ...base, origin: 'http://evil.example' }), PORT)
  assert.equal(cross.status, 403)
  assert.equal(cross.code, 'forbidden_origin')
})

test('入站校验：写方法缺 Origin 拒绝，读方法放行', () => {
  const base = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' }
  const write = guardInboundRequest(fakeReq('POST', base), PORT)
  assert.equal(write.status, 403)
  assert.equal(write.code, 'forbidden_origin')
  assert.equal(guardInboundRequest(fakeReq('GET', { host: `127.0.0.1:${PORT}` }), PORT), null)
})

test('入站校验：写方法要求 application/json', () => {
  const base = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }
  const plain = guardInboundRequest(fakeReq('POST', { ...base, 'content-type': 'text/plain' }), PORT)
  assert.equal(plain.status, 415)
  assert.equal(plain.code, 'unsupported_media_type')
  assert.equal(guardInboundRequest(fakeReq('POST', base), PORT).status, 415)
  assert.equal(
    guardInboundRequest(
      fakeReq('POST', { ...base, 'content-type': 'application/json; charset=utf-8' }),
      PORT,
    ),
    null,
  )
})

test('入站面集成：伪造 Host / 跨源 / 缺 Origin / 非 JSON 被拒，同源写通过', async () => {
  const port = await freePort()
  const server = await startUiServer(
    {
      bridge: {
        async commandValue() {
          return { ok: true, frame: {}, value: null }
        },
      },
      sse: { add() {}, remove() {} },
      connected: () => true,
      identity: 'ui-settings',
      log: () => {},
    },
    port,
  )
  try {
    const same = `http://127.0.0.1:${port}`
    const normal = await rawCall(
      port,
      'POST',
      '/api/command',
      { origin: same, 'content-type': 'application/json' },
      JSON.stringify({ name: 'config.read' }),
    )
    assert.equal(normal.status, 200)
    const forgedHost = await rawCall(port, 'GET', '/api/state', { host: 'evil.example' })
    assert.equal(forgedHost.status, 403)
    const cross = await rawCall(
      port,
      'POST',
      '/api/command',
      { origin: 'http://evil.example', 'content-type': 'application/json' },
      '{}',
    )
    assert.equal(cross.status, 403)
    const noOrigin = await rawCall(
      port,
      'POST',
      '/api/command',
      { 'content-type': 'application/json' },
      '{}',
    )
    assert.equal(noOrigin.status, 403)
    const plain = await rawCall(
      port,
      'POST',
      '/api/command',
      { origin: same, 'content-type': 'text/plain' },
      '{}',
    )
    assert.equal(plain.status, 415)
  } finally {
    await server.close()
  }
})
