// `router` 服务协议级测试：spawn `node execute/main.ts`，自实现最小协议驱动。
// 覆盖：握手 / 控制 / EOF 自退出 / select 纯判定 / 形态非法 bad_args / 未知方法 / 未知能力类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
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
  let stderr = ''
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}; stderr=${stderr}`))
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
    stderrText: () => stderr,
    request,
    hello: () => request('hello', { impl: 'router', gen: 'gen-1' }, 'manifest'),
    call: (args) =>
      request(
        'call',
        { port: 'router', method: 'select', args, env: { run: 'test-run', thread: 't1', now: 0 } },
        ['result', 'error'],
      ),
    close: () => child.stdin.end(),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'router')
    assert.deepEqual(manifest.implements, ['router'])
    assert.deepEqual(manifest.methods.router, ['select'])
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

test('select 无别名 → 主名；有别名候选 → 别名', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const primary = await drv.call({ candidates: ['model', 'model-alt'], failure: 'model_server_error' })
    assert.equal(primary.kind, 'result')
    assert.equal(primary.value, 'model')
    const alias = await drv.call({
      candidates: ['model', 'model-alt'],
      failure: 'model_server_error',
      aliases: ['model-alt'],
    })
    assert.equal(alias.value, 'model-alt')
  } finally {
    drv.close()
  }
})

test('select 主名不在候选清单 → 结构化 no_candidate', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call({ candidates: ['model-alt'], aliases: [] })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'no_candidate')
  } finally {
    drv.close()
  }
})

test('select 形态非法 → bad_args（不崩进程，后续调用仍可用）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call({})).code, 'bad_args')
    assert.equal((await drv.call({ candidates: 'model' })).code, 'bad_args')
    const ok = await drv.call({ candidates: ['model'] })
    assert.equal(ok.value, 'model')
  } finally {
    drv.close()
  }
})

test('未知方法 / 未知能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal(
      (await drv.request('call', { port: 'router', method: 'nope', args: {} }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'select', args: {} }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
