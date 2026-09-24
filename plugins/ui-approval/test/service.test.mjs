// 服务协议级测试（node --test）：hello → manifest、ping、probe、list 的反向调用、
// decide 的续跑计划拼接、drain → bye（等在途）、EOF 自退出。

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

function spawnService(root) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-approval'),
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

/** 合法单条裁决投影：链上 decide 需借此抵达 approval.decide 反向调用后阻塞。 */
const DECIDE_IDS = {
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

test('服务协议级：hello → manifest，ping，probe，list 反向调用，decide 续跑计划，drain → bye', async () => {
  const root = tempDir('service')
  const { child, messages, waitFor } = spawnService(root)
  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-approval', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-approval')
    assert.deepEqual(manifest.implements, ['ui-approval'])
    assert.deepEqual(manifest.methods, { 'ui-approval': ['ping', 'list', 'decide', 'decide_all', 'client.read'] })
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

    // decide：本线程槽 → 服务发 port.call approval.decide，回包后拼 [审批写, …chat.resume]。
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
    assert.equal(decideValue.$directives[0].kind, 'write')
    assert.equal(decideValue.$directives[1].kind, 'extern')
    assert.equal(decideValue.$directives[1].payload.status, 'approved')
    assert.deepEqual(decideValue.$directives[2], {
      kind: 'eval',
      command: 'chat.resume',
      args: { cursor: 'cur-1', thread: 't1', payload: { verdict: 'accept' } },
      inject: { ids: ['ids'] },
    })

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

test('并发安全声明：list 在链上方法在途时先完成；链上方法严格串行', async () => {
  const root = tempDir('concurrent')
  const { child, messages, waitFor } = spawnService(root)
  try {
    // 链上 decide 阻塞在 approval.decide 的反向调用上：不回应答，令其保持「在途」。
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'd1',
        kind: 'call',
        port: 'ui-approval',
        method: 'decide',
        args: DECIDE_IDS,
        env: { run: 'r', thread: 't1', now: 0 },
      }),
    )
    await waitFor(
      () => messages.some((message) => message.kind === 'port.call' && message.method === 'decide'),
      'decide port.call',
    )

    // 链上 ping 排在 decide 之后：decide 收口前不得产出 ping 结果（串行证明）。
    child.stdin.write(
      encodeFrame({ v: '1', id: 'c1', kind: 'call', port: 'ui-approval', method: 'ping', args: {} }),
    )
    await sleep(200)
    assert.equal(messages.some((message) => message.id === 'c1'), false, '链上 ping 必须等 decide 收口')

    // 并发 list：链被 decide 堵住时仍应立即发出 approval.list 反向调用。
    child.stdin.write(
      encodeFrame({ v: '1', id: 'l1', kind: 'call', port: 'ui-approval', method: 'list', args: IDS }),
    )
    await waitFor(
      () => messages.some((message) => message.kind === 'port.call' && message.method === 'list'),
      'list port.call',
    )
    const listCall = messages.find((message) => message.kind === 'port.call' && message.method === 'list')
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
    assert.equal(messages.some((message) => message.id === 'd1'), false, 'list 完成时链上 decide 仍在途')

    // 收口 decide 后，链上 ping 才继续，结果按到达序产出。
    const decideCall = messages.find((message) => message.kind === 'port.call' && message.method === 'decide')
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: decideCall.id,
        kind: 'port.result',
        ok: true,
        value: { $directives: [{ kind: 'extern', payload: { ok: true, id: 'ap-r-0', status: 'approved' } }] },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'decide result')
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.ok(
      messages.findIndex((message) => message.id === 'd1') <
        messages.findIndex((message) => message.id === 'c1'),
      '链上结果按到达序产出',
    )
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('service did not exit on EOF')), 8000)),
  ])
  assert.equal(typeof code, 'number')
  rmSync(root, { recursive: true, force: true })
})
