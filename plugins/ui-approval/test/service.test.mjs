// 服务协议级测试（node --test）：hello → manifest、ping、probe、list 的反向调用、
// decide 的续跑计划拼接、drain → bye（等在途）、EOF 自退出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-approval-${label}-`))
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

function spawnService(root, port) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-approval'),
      CHRONO_UI_PORT_UI_APPROVAL: String(port),
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

const IDS = { approval: { body: { version: 1, tail: null, count: 0 }, refs: {} } }

test('服务协议级：hello → manifest，ping，probe，list 反向调用，decide 续跑计划，drain → bye', async () => {
  const root = tempDir('service')
  const port = await freePort()
  const { child, messages, waitFor } = spawnService(root, port)
  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-approval', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-approval')
    assert.deepEqual(manifest.implements, ['ui-approval'])
    assert.deepEqual(manifest.methods, { 'ui-approval': ['ping', 'list', 'decide', 'decide_all'] })
    assert.equal(manifest.protocol, '1')

    child.stdin.write(encodeFrame({ v: '1', id: 'c1', kind: 'call', port: 'ui-approval', method: 'ping', args: {} }))
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    // list：入口 term 传投影切片 → 服务发 port.call approval.list。
    child.stdin.write(
      encodeFrame({ v: '1', id: 'l1', kind: 'call', port: 'ui-approval', method: 'list', args: IDS }),
    )
    await waitFor(() => messages.some((message) => message.kind === 'port.call'), 'port.call list')
    const listCall = messages.find((message) => message.kind === 'port.call')
    assert.equal(listCall.port, 'approval')
    assert.equal(listCall.method, 'list')
    assert.deepEqual(listCall.args, { queue: { version: 1, tail: null, count: 0 }, refs: {} })
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: listCall.id,
        kind: 'port.result',
        ok: true,
        value: { $directives: [{ kind: 'extern', payload: { ok: true, pending: 0, items: [] } }] },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'l1'), 'list result')
    assert.deepEqual(messages.find((message) => message.id === 'l1').value, {
      $directives: [{ kind: 'extern', payload: { ok: true, pending: 0, items: [], refs: {} } }],
    })

    // decide：本线程槽 → 服务发 port.call approval.decide，回包后拼 [chat.resume, …]。
    const decideIds = {
      input: { body: { slots: { t1: { kind: 'approval.decide', id: 'ap-r-0', verdict: 'accept' } } } },
      approval: {
        body: { version: 1, tail: { def: 'a'.repeat(64) }, count: 1 },
        refs: {
          ['a'.repeat(64)]: {
            id: 'ap-r-0',
            status: 'pending',
            thread: 't1',
            at: '2026-09-20T00:00:00.000Z',
            resume: { command: 'chat.resume', args: { cursor: 'cur-1', thread: 't1' } },
            prev: null,
          },
        },
      },
    }
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'd1',
        kind: 'call',
        port: 'ui-approval',
        method: 'decide',
        args: decideIds,
        env: { run: 'r', thread: 't1', now: 0 },
      }),
    )
    await waitFor(() => messages.filter((message) => message.kind === 'port.call').length >= 2, 'port.call decide')
    const decideCall = messages.filter((message) => message.kind === 'port.call')[1]
    assert.equal(decideCall.method, 'decide')
    assert.equal(decideCall.args.thread_id, 't1')
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: decideCall.id,
        kind: 'port.result',
        ok: true,
        value: {
          $directives: [
            { kind: 'write', request: { op: 'batch', args: { ops: [] } } },
            { kind: 'extern', payload: { ok: true, id: 'ap-r-0', status: 'approved' } },
          ],
        },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'decide result')
    const decideValue = messages.find((message) => message.id === 'd1').value
    assert.deepEqual(decideValue.$directives[0], {
      kind: 'eval',
      command: 'chat.resume',
      args: { cursor: 'cur-1', thread: 't1', payload: { verdict: 'accept' }, ids: decideIds },
    })
    assert.equal(decideValue.$directives[1].kind, 'write')
    assert.equal(decideValue.$directives[2].payload.status, 'approved')

    // 在途调用与 drain 连发：drain 必须等在途调用收口后才发 bye（协议 §2.3）。
    child.stdin.write(encodeFrame({ v: '1', id: 'c2', kind: 'call', port: 'ui-approval', method: 'ping', args: {} }))
    child.stdin.write(encodeFrame({ v: '1', id: 'z1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'z1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'z1').kind, 'bye')
    assert.ok(
      messages.findIndex((message) => message.id === 'c2') < messages.findIndex((message) => message.id === 'z1'),
      '在途调用结果应先于 bye',
    )
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('service did not exit on EOF')), 8000)),
  ])
  assert.equal(typeof code, 'number')
  rmSync(root, { recursive: true, force: true })
})
