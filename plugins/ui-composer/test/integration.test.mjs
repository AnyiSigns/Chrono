// 集成测试（node --test）：起真实服务（execute/main.ts），对一条假宿主 hub 的本地 socket。
// 覆盖：hello → manifest、probe → pong、command / submit 经入站桥真实往返、宿主事件经 /events 转发、
// drain → bye、EOF 自退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { createFrameDecoder, encodeFrame } from '../execute/frames.ts'
import { inboundSocketPath } from '../execute/root.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-composer-${label}-`))
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

function openSse(port, predicate, timeoutMs = 10000) {
  let markReady
  const ready = new Promise((resolveReady) => {
    markReady = resolveReady
  })
  const result = new Promise((resolveResult, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      markReady()
      let buffer = ''
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`SSE timeout; got: ${buffer.slice(0, 600)}`))
      }, timeoutMs)
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const records = buffer
          .split('\n\n')
          .map((part) => {
            const line = part.split('\n').find((entry) => entry.startsWith('data: '))
            if (line === undefined) return null
            try {
              return JSON.parse(line.slice('data: '.length))
            } catch {
              return null
            }
          })
          .filter((record) => record !== null)
        const found = records.find(predicate)
        if (found !== undefined) {
          clearTimeout(timer)
          req.destroy()
          resolveResult(found)
        }
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
  return { ready, result }
}

/** 假宿主 hub：监听入站 socket，按帧 kind 回包；可主动发 `event`。 */
function startHub(socketPath) {
  const received = []
  const sockets = new Set()
  let connectedResolve
  const connected = new Promise((resolveConnected) => {
    connectedResolve = resolveConnected
  })
  const server = createServer((socket) => {
    sockets.add(socket)
    connectedResolve(socket)
    const decoder = createFrameDecoder()
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        received.push(frame)
        if (frame.kind === 'command') {
          socket.write(
            encodeFrame({
              v: '1',
              id: frame.id,
              kind: 'result',
              observations: [
                {
                  kind: 'eval',
                  value: { ok: true, name: frame.name, thread: frame.thread ?? null },
                },
              ],
            }),
          )
        } else if (frame.kind === 'submit') {
          socket.write(encodeFrame({ v: '1', id: frame.id, kind: 'accepted', run: 'run-1' }))
        } else if (frame.kind === 'cancel') {
          socket.write(encodeFrame({ v: '1', id: frame.id, kind: 'accepted' }))
        } else if (frame.kind === 'asset.get') {
          socket.write(
            encodeFrame({
              v: '1',
              id: frame.id,
              kind: 'asset.bytes',
              sha256: frame.sha256,
              size: 3,
              bytes: Buffer.from('abc').toString('base64'),
            }),
          )
        }
      }
    })
    socket.on('error', () => {})
  })
  return {
    server,
    received,
    connected,
    send(frame) {
      for (const socket of sockets) socket.write(encodeFrame(frame))
    },
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise((done) => server.close(() => done()))
    },
  }
}

function spawnService(root, port) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_UI_PORT_UI_COMPOSER: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createFrameDecoder()
  const messages = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      messages.push(message)
      for (const waiter of [...waiters]) waiter()
    }
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  function waitForMessage(predicate, label, timeoutMs = 10000) {
    return new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (predicate()) {
          resolveWait()
          return
        }
        if (Date.now() > deadline) {
          rejectWait(new Error(`timeout waiting ${label}; stderr=${stderr.join('')}`))
          return
        }
        const waiter = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }, 50).unref?.()
      }
      check()
    })
  }
  return { child, messages, waitForMessage }
}

test('真实服务：hello/probe、command/submit 入站往返、事件转发、drain → bye', async () => {
  const root = tempDir('integration')
  const port = await freePort()
  const hub = startHub(inboundSocketPath(root))
  await new Promise((resolveListen, reject) => {
    hub.server.once('error', reject)
    hub.server.listen(inboundSocketPath(root), resolveListen)
  })
  const { child, messages, waitForMessage } = spawnService(root, port)
  try {
    const hubSocket = await hub.connected

    child.stdin.write(
      encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-composer', gen: 'g' }),
    )
    await waitForMessage(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-composer')
    assert.deepEqual(manifest.implements, ['ui-composer'])
    assert.deepEqual(manifest.methods, { 'ui-composer': ['ping'] })

    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'c1',
        kind: 'call',
        port: 'ui-composer',
        method: 'ping',
        args: {},
      }),
    )
    await waitForMessage(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitForMessage(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const state = JSON.parse((await httpCall(port, 'GET', '/api/state')).body)
        if (state.connected === true) break
      } catch {
        // not listening yet
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }

    // 命令经入站桥真实往返
    const command = await httpCall(port, 'POST', '/api/command', {
      name: 'input.read',
      args: { thread: 't1' },
      thread: 't1',
    })
    assert.equal(command.status, 200, command.body)
    assert.deepEqual(JSON.parse(command.body).value, { ok: true, name: 'input.read', thread: 't1' })
    assert.ok(
      hub.received.some(
        (frame) => frame.kind === 'command' && frame.name === 'input.read' && frame.thread === 't1',
      ),
    )

    // 提交经入站桥真实往返
    const submit = await httpCall(port, 'POST', '/api/submit', {
      directives: [{ kind: 'write', request: { op: 'batch', args: { ops: [] } } }],
      thread: 't1',
    })
    assert.equal(submit.status, 202, submit.body)
    assert.equal(JSON.parse(submit.body).run, 'run-1')
    assert.ok(hub.received.some((frame) => frame.kind === 'submit' && frame.thread === 't1'))

    // 宿主事件经本插件 /events 原样转发
    const sse = openSse(port, (record) => record.topic === 'run.started')
    await sse.ready
    hubSocket.write(
      encodeFrame({
        v: '1',
        kind: 'event',
        impl: 'host',
        topic: 'run.started',
        payload: { run: 'r1', thread: '_main' },
      }),
    )
    const record = await sse.result
    assert.equal(record.impl, 'host')
    assert.deepEqual(record.payload, { run: 'r1', thread: '_main' })

    // drain → bye
    child.stdin.write(encodeFrame({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitForMessage(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    await hub.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务 EOF 自退出', async () => {
  const root = tempDir('eof')
  const port = await freePort()
  const { child } = spawnService(root, port)
  const exit = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.stdin.end()
  const code = await Promise.race([
    exit,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('service did not exit on EOF')), 8000),
    ),
  ])
  assert.equal(typeof code, 'number')
  rmSync(root, { recursive: true, force: true })
})
