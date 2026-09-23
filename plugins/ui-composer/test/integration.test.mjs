// 服务协议级测试（node --test）：起真实服务（execute/main.ts），经 stdio 帧往返。
// 覆盖：hello → manifest、ping、client.read 路径穿越拒绝、probe → pong、drain → bye、EOF 自退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-composer-${label}-`))
}

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

function spawnService(root) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-composer'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createDecoder()
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

  function waitFor(predicate, label, timeoutMs = 10000) {
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
  return { child, messages, waitFor }
}

test('真实服务：hello → manifest、ping、client.read 越界拒、probe、drain → bye', async () => {
  const root = tempDir('service')
  const { child, messages, waitFor } = spawnService(root)
  try {
    child.stdin.write(
      encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-composer', gen: 'g' }),
    )
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-composer')
    assert.deepEqual(manifest.implements, ['ui-composer'])
    assert.deepEqual(manifest.methods, { 'ui-composer': ['ping', 'client.read'] })

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
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    // client.read 路径穿越：越界路径结构化 bad_args，不崩进程
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'r1',
        kind: 'call',
        port: 'ui-composer',
        method: 'client.read',
        args: { path: '../plugin.json' },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'r1'), 'client.read rejection')
    assert.equal(messages.find((message) => message.id === 'r1').code, 'bad_args')

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    child.stdin.write(encodeFrame({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务 EOF 自退出', async () => {
  const root = tempDir('eof')
  const { child } = spawnService(root)
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
